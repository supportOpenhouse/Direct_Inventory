"""Activity log writer. Append-only table; one helper for the whole app."""
from __future__ import annotations

import json
from typing import Any

# User-id fields whose before/after we render as NAMES instead of raw ids, so the
# log reads "[Animesh Singh]" / "Aman Dixit" instead of "[38]" / "16". Raw ids are
# kept in metadata (before_ids / after_ids) so entries stay traceable.
_NAME_ARRAY_FIELDS = {"assigned_rm_ids"}                 # int[] → "[Name, Name]"
_NAME_SCALAR_FIELDS = {"assigned_mgr_id", "manager"}     # int   → "Name"


def _coerce_ids(value: Any) -> list[int]:
    """Extract integer user ids from a before/after value: a Python list/int,
    None, or a json-ish array string like '[38, 40]'. Anything else → []."""
    if value is None or isinstance(value, bool):
        return []
    if isinstance(value, int):
        return [value]
    if isinstance(value, (list, tuple)):
        out = []
        for x in value:
            try:
                out.append(int(x))
            except (TypeError, ValueError):
                pass
        return out
    s = str(value).strip()
    if s.startswith("["):
        try:
            return [int(x) for x in json.loads(s)]
        except (ValueError, TypeError):
            return []
    if s.isdigit():
        return [int(s)]
    return []


def _coerce_id(value: Any) -> int | None:
    ids = _coerce_ids(value)
    return ids[0] if ids else None


def _user_labels(cur, ids) -> dict[int, str]:
    """Map {id: display label} — name, then email, then '#<id>' for a deleted user."""
    ids = sorted({i for i in ids})
    if not ids:
        return {}
    cur.execute(
        "SELECT id, COALESCE(NULLIF(TRIM(name), ''), email, '#' || id) AS label "
        "FROM users WHERE id = ANY(%s)",
        (ids,),
    )
    return {r["id"]: r["label"] for r in cur.fetchall()}


def _label_array(value: Any, names: dict[int, str]) -> str:
    """Render an id array as '[Name A, Name B]' (or '[]' when empty)."""
    ids = _coerce_ids(value)
    if not ids:
        # Already-named string (contains letters) → leave untouched.
        if isinstance(value, str) and any(c.isalpha() for c in value):
            return value
        return "[]"
    return "[" + ", ".join(names.get(i, f"#{i}") for i in ids) + "]"


def _label_scalar(value: Any, names: dict[int, str]) -> str | None:
    """Render a single id as its name (None stays None / '—')."""
    if value is None:
        return None
    ids = _coerce_ids(value)
    if not ids:
        s = str(value).strip()
        return s or None
    return names.get(ids[0], f"#{ids[0]}")


def bind_assigned_mgr(entries: list[dict]) -> list[dict]:
    """Fold each entity's assigned_mgr_id change INTO its assigned_rm_ids entry.

    When a property's RM is reassigned the manager is auto-derived from the new
    RM, producing two audit rows per uid. This binds them: for any entity that
    has BOTH changes in this batch, the manager ids are stashed on the
    assigned_rm_ids entry (mgr_before_id / mgr_after_id — resolved to names at
    write time) and the standalone assigned_mgr_id row is dropped. A manager
    change with NO RM change in the same batch is left as its own entry.

    Returns a new list; the kept entries' metadata dicts may be mutated.
    """
    rm_by_eid: dict[Any, dict] = {}
    for e in entries:
        if e.get("field") == "assigned_rm_ids":
            rm_by_eid[e.get("entity_id")] = e
    out = []
    for e in entries:
        if e.get("field") == "assigned_mgr_id":
            rm = rm_by_eid.get(e.get("entity_id"))
            if rm is not None:
                meta = dict(rm.get("metadata") or {})
                meta["mgr_before_id"] = _coerce_id(e.get("before_value"))
                meta["mgr_after_id"] = _coerce_id(e.get("after_value"))
                rm["metadata"] = meta
                continue  # drop the standalone manager row
        out.append(e)
    return out


def _needs_names(field: str | None, metadata: dict | None) -> bool:
    if field in _NAME_ARRAY_FIELDS or field in _NAME_SCALAR_FIELDS:
        return True
    return bool(metadata) and ("mgr_before_id" in metadata or "mgr_after_id" in metadata)


def _ids_in(field: str | None, before: Any, after: Any, metadata: dict | None) -> list[int]:
    ids: list[int] = []
    if field in _NAME_ARRAY_FIELDS or field in _NAME_SCALAR_FIELDS:
        ids += _coerce_ids(before) + _coerce_ids(after)
    if metadata:
        for k in ("mgr_before_id", "mgr_after_id"):
            if metadata.get(k) is not None:
                ids.append(metadata[k])
    return ids


def _relabel(field, before, after, metadata, names):
    """Return (before, after, metadata) with user ids resolved to names."""
    meta = dict(metadata or {})
    if field in _NAME_ARRAY_FIELDS:
        meta.setdefault("before_ids", _coerce_ids(before))
        meta.setdefault("after_ids", _coerce_ids(after))
        before, after = _label_array(before, names), _label_array(after, names)
    elif field in _NAME_SCALAR_FIELDS:
        meta.setdefault("before_ids", _coerce_ids(before))
        meta.setdefault("after_ids", _coerce_ids(after))
        before, after = _label_scalar(before, names), _label_scalar(after, names)
    # Bound manager (rides on an assigned_rm_ids row): id → name.
    if "mgr_before_id" in meta or "mgr_after_id" in meta:
        mb, ma = meta.get("mgr_before_id"), meta.get("mgr_after_id")
        meta["mgr_before"] = names.get(mb) if mb is not None else None
        meta["mgr_after"] = names.get(ma) if ma is not None else None
    return before, after, meta


def log(
    cur,
    *,
    actor_user_id: int | None,
    actor_email: str | None,
    entity_type: str,
    entity_id: str | None,
    action: str,
    field: str | None = None,
    before_value: Any = None,
    after_value: Any = None,
    metadata: dict | None = None,
) -> None:
    """Insert one activity_log row using the given cursor.

    The caller controls the transaction so log writes commit together with the
    state change they describe.
    """
    if _needs_names(field, metadata):
        names = _user_labels(cur, _ids_in(field, before_value, after_value, metadata))
        before_value, after_value, metadata = _relabel(
            field, before_value, after_value, metadata, names
        )
    cur.execute(
        """
        INSERT INTO activity_log (
            actor_user_id, actor_email, entity_type, entity_id,
            action, field, before_value, after_value, metadata
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
        """,
        (
            actor_user_id,
            actor_email,
            entity_type,
            entity_id,
            action,
            field,
            None if before_value is None else str(before_value),
            None if after_value is None else str(after_value),
            json.dumps(metadata) if metadata else None,
        ),
    )


def log_many(cur, rows: list[dict]) -> None:
    """Batch-insert many activity_log rows in ONE round-trip.

    Each dict accepts the same keys as log()'s kwargs. Calling log() in a loop
    is one INSERT per row, which can blow the request timeout on large bulk
    operations — use this for per-row audit writes instead.
    """
    if not rows:
        return
    from psycopg2.extras import execute_values

    # Resolve every user id (rm arrays, scalar mgr, bound mgr) in ONE query.
    id_pool: set[int] = set()
    for r in rows:
        if _needs_names(r.get("field"), r.get("metadata")):
            id_pool.update(_ids_in(r.get("field"), r.get("before_value"),
                                   r.get("after_value"), r.get("metadata")))
    names = _user_labels(cur, id_pool) if id_pool else {}
    for r in rows:
        if _needs_names(r.get("field"), r.get("metadata")):
            b, a, m = _relabel(r.get("field"), r.get("before_value"),
                               r.get("after_value"), r.get("metadata"), names)
            r["before_value"], r["after_value"], r["metadata"] = b, a, m

    values = [
        (
            r.get("actor_user_id"),
            r.get("actor_email"),
            r.get("entity_type"),
            r.get("entity_id"),
            r.get("action"),
            r.get("field"),
            None if r.get("before_value") is None else str(r.get("before_value")),
            None if r.get("after_value") is None else str(r.get("after_value")),
            json.dumps(r["metadata"]) if r.get("metadata") else None,
        )
        for r in rows
    ]
    execute_values(
        cur,
        """
        INSERT INTO activity_log (
            actor_user_id, actor_email, entity_type, entity_id,
            action, field, before_value, after_value, metadata
        ) VALUES %s
        """,
        values,
        template="(%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)",
    )
