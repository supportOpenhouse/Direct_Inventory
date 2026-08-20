# Multi-Manager Migration Playbook

How to convert a **single-parent foreign key** (`manager_id INTEGER`) into a
**multi-parent array** (`manager_ids INTEGER[]`) across database, backend, and
frontend — without losing existing data.

Written from a completed migration on a Flask + PostgreSQL + React admin
dashboard, where every RM had exactly one manager and needed to have several.
The names below (`rms`, `manager_id`, "manager", "RM") are from that codebase —
swap in your own, the shape is what transfers.

**Applies to any "one X, now many X" relationship:** owner, assignee, approver,
team lead, category, region. If a table has a self-referencing or lookup FK
column that scoping logic reads, this is your recipe.

---

## The one thing that makes this work

Almost every such system has a **single load-bearing query** that turns the
parent link into a visibility scope — usually a recursive CTE that walks the
hierarchy. Find it first. Everything else is bookkeeping.

In our codebase it was this, duplicated in exactly two files:

```sql
WITH RECURSIVE my_team(id) AS (
  SELECT id FROM rms WHERE id = %s          -- me
  UNION
  SELECT r.id FROM rms r
    JOIN my_team t ON r.manager_id = t.id   -- everyone under me, recursively
) SELECT id FROM my_team
```

The entire migration hinges on changing one join condition:

```diff
- JOIN my_team t ON r.manager_id = t.id
+ JOIN my_team t ON t.id = ANY(r.manager_ids)
```

Because submissions scoping, ticket scoping, and partner scoping all called
that same fragment, **that one line change propagated multi-manager visibility
through every feature** with no other query edits. A person listed in two
managers' arrays now appears in both managers' subtrees independently.

### Why an array beats a junction table here

A junction table (`rm_extra_managers`) is the textbook answer, and it is the
right call if you need per-edge metadata (assigned_at, is_primary, weight).
But it collides with a PostgreSQL restriction: **a recursive CTE may reference
itself only once**, so you cannot simply add a second `UNION ... JOIN my_team`
branch for the second edge type. You have to union the *edges* first:

```sql
WITH RECURSIVE my_team(id) AS (
  SELECT id FROM rms WHERE id = %s
  UNION
  SELECT e.child FROM (
    SELECT id AS child, manager_id AS parent FROM rms
    UNION ALL
    SELECT rm_id, manager_id FROM rm_extra_managers
  ) e JOIN my_team t ON e.parent = t.id
) SELECT id FROM my_team
```

That works, but it means two sources of truth for "who manages whom," two write
paths, and a join that reads worse. **If you need no edge metadata, the array
is simpler at every layer** — one column, one write, `= ANY()` in the join.
Choose deliberately; this playbook takes the array route.

---

## Step 0 — Find every touchpoint before editing anything

Do this first and read all of it. The count tells you the size of the job.

```bash
grep -rn "manager_id\|managerId" --include="*.py" --include="*.js" \
  --include="*.jsx" --include="*.ts" --include="*.tsx" --include="*.sql" . \
  | grep -v node_modules
```

Ours returned 49 hits across 7 files. Sort them into five buckets — this is the
work plan:

| Bucket | What it is | Risk |
|---|---|---|
| Scope queries | the recursive CTE(s) | **highest** — silent wrong-data if missed |
| Read queries | `SELECT ... manager_id` + their fallback variants | breaks loudly |
| API responses | the JSON shape handed to clients | breaks the frontend |
| Write/validation | the PATCH/POST that sets the value | breaks loudly |
| Frontend comparisons | `x.manager_id === me` | **silently wrong** — no error |

The two marked "silent" are what bite. An equality check against an array
returns `false` forever rather than throwing, so a manager just quietly sees an
empty team. Grep for the comparisons specifically; don't rely on the app
crashing to find them.

---

## Step 1 — The migration

In-place type change. Existing values become one-element arrays; `NULL` stays
`NULL`. No data is lost and no separate backfill script is needed.

```sql
-- Convert rms.manager_id (integer) -> rms.manager_ids (integer[]).
-- Idempotent: the guard tests for the OLD column name, which the rename at the
-- end removes, so re-running is a no-op.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'rms' AND column_name = 'manager_id'
    ) THEN
        -- A single-column FK cannot survive the array conversion.
        ALTER TABLE rms DROP CONSTRAINT IF EXISTS rms_manager_id_fkey;

        ALTER TABLE rms
            ALTER COLUMN manager_id TYPE integer[]
            USING CASE WHEN manager_id IS NULL THEN NULL
                       ELSE ARRAY[manager_id] END;

        ALTER TABLE rms RENAME COLUMN manager_id TO manager_ids;
    END IF;
END $$;
```

**Three things worth knowing:**

- **You lose referential integrity.** Postgres has no FK constraint on array
  elements. The application must validate that every id exists — see Step 3.
  This is the real cost of the array approach; accept it knowingly.
- **Decide your empty convention and hold it.** We use `NULL` for "no
  managers" and treat `NULL` and `'{}'` as identical on read (`or []` in
  Python). Pick one, write it in a comment, and normalize on read so downstream
  code never has to care.
- **Renaming is optional.** Keeping the name `manager_id` for an array column
  would avoid touching read queries, but it lies to every future reader. Rename
  it. The compiler-less languages in your stack won't catch a stale reference,
  so the rename is what forces you to visit every call site — that is a
  feature.

**Optional index.** Only if the table is large: `= ANY(col)` does not use a GIN
index. If you need one, write the join as `r.manager_ids @> ARRAY[t.id]` and add
`CREATE INDEX ... USING GIN (manager_ids)`. A staff table of dozens of rows
needs neither; we skipped it.

---

## Step 2 — Backend read paths

**The CTE** (highest value, do it first):

```python
_TEAM_RM_IDS_SQL = (
    "(WITH RECURSIVE my_team(id) AS ("
    " SELECT id FROM rms WHERE id = %s"
    " UNION"
    " SELECT r.id FROM rms r JOIN my_team t ON t.id = ANY(r.manager_ids)"
    ") SELECT id FROM my_team)"
)
```

Keep `UNION` (not `UNION ALL`) — it terminates cycles. Multi-parent graphs make
cycles *more* likely than single-parent chains did, so this matters more now
than it did before.

**Plain selects:** `r.manager_id` → `r.manager_ids`.

**Fallback/defensive queries:** if your codebase has degraded-mode queries for
partially-migrated schemas, the null literal must change type too, or the query
errors on the cast:

```diff
- NULL::integer AS manager_id
+ NULL::integer[] AS manager_ids
```

**API responses — always emit a list, never null:**

```python
"manager_ids": r.get("manager_ids") or []
```

Do this at every boundary. It means the frontend can call `.includes()`
unconditionally and never guard for null, which removes a whole class of
`TypeError: Cannot read properties of null`. Also give sibling record types
that have no managers (admins, in our case) an explicit `[]` so the response
shape is uniform.

**Session/JWT payload:** if the parent id is baked into the token, change it
there too (`manager_id` → `manager_ids`) and remember that **already-issued
tokens still carry the old scalar key** — see the stale-session note in Step 5.

---

## Step 3 — Backend write path

This is where the real logic change lives. It must accept a list, validate
every element, and stay backward-compatible with in-flight clients.

```python
if source == "rm" and ("manager_ids" in data or "manager_id" in data):
    if "manager_ids" in data:
        raw = data["manager_ids"]
        if raw in (None, ""):
            raw = []
    else:
        # Legacy single-value alias — normalise to a one-element list.
        legacy = data["manager_id"]
        raw = [] if legacy in (None, "", 0, "0") else [legacy]

    if not isinstance(raw, list):
        return jsonify({"error": "manager_ids must be a list of integers or null"}), 400

    mids = []
    for mid in raw:
        try:
            mid = int(mid)
        except (TypeError, ValueError):
            return jsonify({"error": "manager_ids must be a list of integers or null"}), 400
        if mid == user_id:
            return jsonify({"error": "a user can't be their own manager"}), 400
        if mid not in mids:                      # dedupe, preserve order
            mids.append(mid)

    # One round-trip validates every id, instead of N queries in a loop.
    if mids:
        cur.execute(
            "SELECT id FROM rms WHERE id = ANY(%s)"
            " AND COALESCE(is_manager, FALSE) = TRUE",
            (mids,),
        )
        found = {row["id"] for row in cur.fetchall()}
        bad = [m for m in mids if m not in found]
        if bad:
            return jsonify({
                "error": "not a manager (or not found): " + ", ".join(str(m) for m in bad),
            }), 400

    sets.append("manager_ids = %s")
    params.append(mids or None)                  # empty -> NULL
```

**Five rules this encodes:**

1. **Validate every element.** The database no longer does it for you.
2. **Batch the existence check** with `= ANY(%s)` — a loop of single-row
   queries is the easy mistake when a scalar becomes a list.
3. **Dedupe.** A UI checkbox glitch or a double-submit must not produce
   `[7, 7]`.
4. **Keep the self-reference guard** you already had. Deep cycles (A→B→A) can
   stay tolerated *if* your CTE uses `UNION`, which guards traversal.
5. **Accept the legacy scalar key.** A browser tab opened before the deploy
   will still POST `manager_id`. Aliasing it costs six lines and prevents
   confusing 400s during rollout. Document it as legacy so it can be deleted
   later.

**psycopg2 note:** Python lists adapt to Postgres arrays natively in both
directions. Pass `[1, 2]` straight through as a parameter and read the column
back as a Python list — no `json.dumps`, no string building, no special cursor
config.

---

## Step 4 — Tests

The highest-leverage move: **make the shared fixture multi-parent**, so every
existing test exercises the array path instead of only your new test.

```python
# Before: rm reports to manager.
# After:  rm reports to BOTH manager and manager2.
cur.execute(
    "INSERT INTO rms (name, phone, is_manager, is_viewer, manager_ids) "
    "VALUES (%s, %s, FALSE, FALSE, %s) RETURNING id",
    (f"{tag}-rm", "+91 9000000002", [ids["manager"], ids["manager2"]]),
)
```

Every pre-existing scoping assertion now runs against a two-manager record —
if the array logic is wrong anywhere, the old tests fail, not just the new one.
Remember to add the second parent to fixture teardown.

Then one test for the actual new capability:

```python
@requires_db
def test_rm_with_two_managers_visible_to_both(client, graph):
    # Each manager's team CTE must independently include rm.
    client.post("/api/tickets", headers=graph["headers"]["admin"],
                json={"submission_id": graph["submission"], "title": "T-dual"})
    assert len(client.get("/api/tickets", headers=graph["headers"]["manager"]).get_json()["items"]) == 1
    assert len(client.get("/api/tickets", headers=graph["headers"]["manager2"]).get_json()["items"]) == 1
```

Also assert the **negative**: an unrelated peer still sees nothing. Widening a
scope is exactly the kind of change that can over-share, and a passing
"everyone sees it" test looks identical to a broken permission boundary.

---

## Step 5 — Frontend

**The dangerous edit — equality becomes containment.** These fail silently:

```diff
- if (isManager && r.manager_id !== user?.rm_id) return false;
+ if (isManager && !(r.manager_ids || []).includes(user?.rm_id)) return false;
```

```diff
- const teamOf = (mgrId) => rms.filter((r) => r.manager_id === mgrId);
+ const teamOf = (mgrId) => rms.filter((r) => (r.manager_ids || []).includes(mgrId));
```

Keep the `|| []` guard even though the API normalizes — it costs nothing and
survives a cached response from the old deploy.

**Display — join, don't print one:**

```js
const managerNames = (ids) => (ids || []).map(managerName).filter(Boolean).join(', ');
```

`.filter(Boolean)` matters: ids can reference a deactivated record missing from
your active-only lookup, and you want it skipped, not rendered as `undefined`.

**Stale sessions.** A user logged in before the deploy holds a cached session
object with the old scalar key. One line keeps them working until their token
rotates:

```js
const myManagerIds = user.managerIds || (user.managerId != null ? [user.managerId] : []);
```

**Form state:** `''` → `[]`, and the submit sends the array. Initialize the
draft defensively: `Array.isArray(u.manager_ids) ? u.manager_ids.map(Number) : []`.

### The input control

A `<select>` becomes a multi-select. Two lessons from doing this badly first:

- **Reuse the component your app already has.** We shipped a raw checkbox list,
  and it inherited the form's label styles and sprawled across two rows. The
  codebase already contained a portal-rendered, type-to-filter multiselect used
  elsewhere; swapping it in took four lines and matched the app instantly.
  Grep for an existing multiselect before writing one.
- **Watch vertical space in inline/table-row forms.** The stock component
  rendered selected values as chips *below* the control, which made that field
  taller than its neighbours — and because the row aligned items to the bottom,
  its label sat visibly out of line. We added an opt-in `chips={false}` mode
  that drops the chips row and reads the selection out inside the control
  ("Amar Singh, Priya Nair") instead of counting it ("2 selected"). One line
  tall, aligned, and still shows *who* without opening the menu. Add such a
  mode as a prop; don't change the shared component's default for everyone.

**CSS specificity gotcha we hit:** a global `input[type=text]` rule
out-specified the multiselect's own `.sms-input` reset, so the inner field drew
its own border and padding *inside* the control's border — a visible box inside
a box. Attribute selectors count as a class for specificity, so the reset must
be at least as specific (`.sms-control .sms-input`). If your dropdown looks
like it has a double border, this is why.

---

## Deploy order

Renaming the column means **old code cannot read the new schema and new code
cannot read the old one.** Choose consciously:

**Option A — ship together (what we did).** Apply the migration and deploy the
backend in the same window. Simple, and correct for an internal dashboard where
a few seconds of 500s at 2am is acceptable. Write the migration into your
runbook as *required before deploy*, because manager-scoped endpoints will
error until it runs.

**Option B — zero downtime.** If you can't take a window:

1. Add `manager_ids` as a **new** column, leave `manager_id` in place.
2. Deploy code that **writes both** and reads `manager_ids`, falling back to
   `manager_id` when the array is null.
3. Backfill: `UPDATE rms SET manager_ids = ARRAY[manager_id] WHERE manager_ids IS NULL AND manager_id IS NOT NULL;`
4. Deploy code that reads only `manager_ids`.
5. Drop `manager_id` in a later migration.

Option B is four deploys instead of one. Only pay that if real users would
notice the gap.

---

## Verification checklist

Before calling it done:

- [ ] `grep -rn "manager_id\b"` returns **only** intentional legacy-alias hits
- [ ] Backend files compile / typecheck
- [ ] Frontend builds
- [ ] Test suite result is **identical to the pre-change baseline** — stash your
      changes, run, unstash, run, compare. This distinguishes your regressions
      from failures the repo already had.
- [ ] Migration applied to the target database
- [ ] DB-backed tests pass with the multi-parent fixture
- [ ] Manual: assign two managers to one person, confirm **both** see their
      data, and confirm an **unrelated** peer manager still sees nothing
- [ ] Manual: a person with **zero** managers still works (the null path)
- [ ] Manual: deactivating one of two managers leaves the other's access intact

That third-to-last item is the one people skip. Widening a visibility scope is
easy to over-widen, and nothing in the type system will tell you.

---

## Summary of the change surface

For calibration — this was the complete diff on a mid-size dashboard:

| Layer | Files | What changed |
|---|---|---|
| Database | 1 new migration | in-place type change + rename |
| Scope queries | 2 | one join condition each |
| Read queries | 3 | column name, `NULL::integer[]` casts, `or []` normalization |
| Write path | 1 | list validation, batch existence check, legacy alias |
| Session/JWT | 1 | payload key + response shape |
| Frontend | 3 | `===` → `.includes()`, multiselect control, display join |
| Tests | 2 | multi-parent fixture + one new assertion |

**~150 lines across 9 files.** The work is in finding all of them, not in
writing any one of them.
