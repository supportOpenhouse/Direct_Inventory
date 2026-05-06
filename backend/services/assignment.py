"""Resolve which RM (and manager) should own a given inventory row.

Resolution order, first match wins:
  1. exact (city, locality, society)
  2. (city, locality, society IS NULL)
  3. (city, locality IS NULL, society IS NULL)   -- city-wide fallback
"""
from __future__ import annotations


def resolve_assignment(cur, *, city: str, locality: str | None, society: str | None):
    """Return (rm_user_id, manager_user_id) or (None, None) if no mapping found."""
    cur.execute(
        """
        SELECT rm_user_id, manager_user_id
        FROM rm_mapping
        WHERE city = %s
          AND (
                (society IS NOT NULL AND society = %s AND locality IS NOT DISTINCT FROM %s)
             OR (society IS NULL AND locality = %s)
             OR (society IS NULL AND locality IS NULL)
          )
        ORDER BY
            (society IS NOT NULL AND society = %s) DESC,
            (locality = %s) DESC NULLS LAST,
            id ASC
        LIMIT 1
        """,
        (city, society, locality, locality, society, locality),
    )
    row = cur.fetchone()
    if not row:
        return (None, None)
    return (row["rm_user_id"], row["manager_user_id"])
