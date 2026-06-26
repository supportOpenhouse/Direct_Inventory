# Reassigned-lead priority star

## Goal
When a lead is manually reassigned from one RM to a *different* RM, flag it so the
new RM sees it as a priority — a distinctly-colored star, a priority bump, and a
top-of-board sort position. Color encodes who reassigned it.

## Data model
Two columns on `inventory` (migration 032):
- `reassigned BOOLEAN NOT NULL DEFAULT FALSE`
- `reassigned_by_id INT REFERENCES users(id)` (nullable)
- Partial index `WHERE reassigned = TRUE` (sort/filter).

## Trigger — "RM → a different RM" only
Set `reassigned=true`, `reassigned_by_id=<actor>`, `priority=true` when an RM
reassignment changes the assignee, in all manual paths:
- `bulk_update` (BulkActionBar "Assign RM")
- `set_assigned_rms` (admin PUT `/<oh_id>/assigned-rms`)
- `records.py` PATCH (Edit Details + inline ExpandPanel RM change)

Condition (per row): **old `assigned_rm_ids` non-empty AND new non-empty AND
`set(old) != set(new)`**. First-time assignment of an unassigned lead (old empty)
does NOT flag. Auto-assignment (`assign_missing_batch`) never flags.

## Star color — overrides everything
`starColor(item)` new top branch (above `star_color`/`priority`/`cp_match`):
- `reassigned` + `reassigned_by_role === 'admin'` → `pink` (`#fd4ad8`)
- `reassigned` + `reassigned_by_role === 'manager'` → `blue` (`#02f5d0`)
- `reassigned` + other role (rm/unknown) → fall through to normal rules (RM color TBD)

API returns `reassigned`, `reassigned_by_id`, and `reassigned_by_role`
(LEFT JOIN `users`) on list + single-record projections. A shared `starClass()`
helper maps color→CSS class for the 3 renderers (InventoryTable, Leads,
QualifiedLeads); CSS adds the two fills.

## Sort bump (scoped)
Smart sort gets a leading bucket: `reassigned` leads first. Column sorts unchanged.

## Dismiss
The pink/blue star overrides the manual star, so clicking the star on a reassigned
lead **clears** it: PATCH `{ reassigned: false }` → server also nulls
`reassigned_by_id`. `reassigned` is added to PATCH-allowed fields.

## Out of scope / deferred
- RM-initiated reassign color (user will specify later).
- No change to `assign_missing_batch` auto-assignment.
