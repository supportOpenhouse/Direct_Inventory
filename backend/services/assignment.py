"""Resolve which RM (and manager) should own a given inventory row.

Mapping lives on the users table (the standalone rm_mapping table was retired
in migration 016):
  users.society[] — societies an RM is scoped to  (most specific)
  users.cities[]  — cities an RM / manager covers (fallback)
  users.manager   — FK to users(id): the RM's reporting manager

Resolution, first match wins:
  RM      — active rm whose society[] contains the lead's society;
            else active rm whose cities[] contains the lead's city.
  Manager — the matched RM's `manager`. If no RM matched, or that RM has no
            manager set, fall back to an active manager covering the city.

When several users qualify, the lowest id wins (stable, arbitrary). Rebuild
finer-grained tie-breaking with the new mapping page if needed.
"""
from __future__ import annotations


def resolve_assignment(cur, *, city: str, locality: str | None = None, society: str | None = None):
    """Return (rm_user_id, manager_user_id); either may be None if unmatched.

    `locality` is still accepted so existing call sites need no change, but it
    is no longer used — locality-level scoping was not carried into the users
    model (locality folds into users.micro_market, which isn't matched here).
    """
    rm_id = None
    mgr_id = None

    if society:
        cur.execute(
            """SELECT id, manager FROM users
               WHERE role = 'rm' AND is_active = TRUE AND %s = ANY(society)
               ORDER BY id LIMIT 1""",
            (society,),
        )
        row = cur.fetchone()
        if row:
            rm_id, mgr_id = row["id"], row["manager"]

    if rm_id is None and city:
        cur.execute(
            """SELECT id, manager FROM users
               WHERE role = 'rm' AND is_active = TRUE AND %s = ANY(cities)
               ORDER BY id LIMIT 1""",
            (city,),
        )
        row = cur.fetchone()
        if row:
            rm_id, mgr_id = row["id"], row["manager"]

    # Manager comes from the RM's `manager` link. Fall back to a city-level
    # manager when no RM matched, or the matched RM has no manager set.
    if mgr_id is None and city:
        cur.execute(
            """SELECT id FROM users
               WHERE role = 'manager' AND is_active = TRUE AND %s = ANY(cities)
               ORDER BY id LIMIT 1""",
            (city,),
        )
        row = cur.fetchone()
        if row:
            mgr_id = row["id"]

    return (rm_id, mgr_id)
