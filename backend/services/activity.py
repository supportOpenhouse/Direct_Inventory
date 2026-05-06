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
