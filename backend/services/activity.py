"""Activity log writer. Append-only table; one helper for the whole app."""
from __future__ import annotations

import json
from typing import Any

# Fields whose before/after values are user-id arrays we want the log to show as
# NAMES instead of raw ids (e.g. "[38]" → "[Animesh Singh]"). The change is
# resolved centrally here so every call site (bulk-update, set-assigned-rms,
# single PATCH) gets names without touching each one. The raw ids are preserved
# in metadata (before_ids / after_ids) so the entry stays traceable.
# NOTE: scoped to assigned_rm_ids for now — add "assigned_mgr_id" / "manager"
# here (both single-id scalars) when those should show names too.
_NAME_ARRAY_FIELDS = {"assigned_rm_ids"}


def _coerce_ids(value: Any) -> list[int]:
    """Best-effort extract integer user ids from a before/after value: a Python
    list/int, None, or a json-ish array string like '[38, 40]'."""
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
    return []


def _user_labels(cur, ids) -> dict[int, str]:
    """Map {id: display label} for the given ids — name, falling back to email,
    then '#<id>' for a since-deleted user."""
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
        return "[]"
    return "[" + ", ".join(names.get(i, f"#{i}") for i in ids) + "]"


def _names_meta(metadata: dict | None, before_value: Any, after_value: Any) -> dict:
    """Stash the raw ids alongside whatever metadata the caller passed."""
    meta = dict(metadata or {})
    meta.setdefault("before_ids", _coerce_ids(before_value))
    meta.setdefault("after_ids", _coerce_ids(after_value))
    return meta


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
    if field in _NAME_ARRAY_FIELDS:
        names = _user_labels(cur, _coerce_ids(before_value) + _coerce_ids(after_value))
        metadata = _names_meta(metadata, before_value, after_value)
        before_value = _label_array(before_value, names)
        after_value = _label_array(after_value, names)
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

    # Resolve all assigned_rm_ids in ONE users query, then relabel each row to
    # names (raw ids preserved in metadata).
    id_pool: set[int] = set()
    for r in rows:
        if r.get("field") in _NAME_ARRAY_FIELDS:
            id_pool.update(_coerce_ids(r.get("before_value")))
            id_pool.update(_coerce_ids(r.get("after_value")))
    names = _user_labels(cur, id_pool) if id_pool else {}
    for r in rows:
        if r.get("field") in _NAME_ARRAY_FIELDS:
            b, a = r.get("before_value"), r.get("after_value")
            r["metadata"] = _names_meta(r.get("metadata"), b, a)
            r["before_value"] = _label_array(b, names)
            r["after_value"] = _label_array(a, names)

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
