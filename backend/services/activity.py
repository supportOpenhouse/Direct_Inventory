"""Activity log writer. Append-only table; one helper for the whole app."""
from __future__ import annotations

import json
from typing import Any


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
