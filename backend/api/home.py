"""Home board summary — one scoped aggregate powering the Summary cards.

GET /api/home/summary returns the six Summary-card numbers in a single
round-trip. Everything is visibility scoped exactly like the inventory list
(admin: all; manager: their cities; rm: rows assigned to them).

Shape:
  {
    leads:     { lead_new, lead_old, active_new, active_old },
    qualified: { new, old },
    follow_up: { new, old },
    visit:     { completed, to_be_completed, overdue },
    supply:    { pipeline, token_to_ama, onboarded, rejected_post_visit, cancelled_post_token },
    rejected:  { total, by_reason: { <reason>: n } },
    todays_task: { leads: { total, worked }, active: { total, worked } },
  }

  "new" = the row ENTERED that stage today (IST), read from activity_log; "old"
  = currently in that stage but entered earlier. For the intake 'lead' stage,
  "new" = created today (a lead enters at creation).
  visit.completed = rows now in any Supply Closure Tracker stage
  (a completed visit progresses there); to_be_completed / overdue come from the
  property-DB scheduled visit date for stage='visit_scheduled' rows.

  todays_task: both tasks' total = leads CREATED today (IST). leads.worked =
  created-today leads moved out of 'lead' (Task 1: lead→active). active.worked =
  created-today leads moved past 'active' (Task 2: active→qualified) — only
  computed once Task 1 is complete, else null (the card is locked client-side).
"""
from __future__ import annotations

from flask import Blueprint, g, jsonify

from ..db import get_conn
from .auth import require_auth
from .inventory._common import _scope_clause, overdue_visit_ids

# Morning-cohort task progress. For a given stage, count the rows that were in
# that stage at the START of today (IST) and how many have since moved out
# ("worked"). The morning stage is reconstructed from activity_log — no daily
# snapshot/cron needed: it's the after_value of the latest stage_change before
# today; else the before_value of the earliest stage_change today (the stage the
# row sat in this morning before its first move); else the current stage (never
# changed). Only rows that existed before today can have a morning stage.

bp = Blueprint("home", __name__, url_prefix="/api/home")

# IST calendar today; created_at is TIMESTAMPTZ so convert to IST first.
_TODAY_IST = "(NOW() AT TIME ZONE 'Asia/Kolkata')::DATE"
_CREATED_IST = "(created_at AT TIME ZONE 'Asia/Kolkata')::DATE"

# A row counts as "qualified today" when its stage was moved to 'qualified' on
# today's IST date — read from activity_log, NOT from created_at (which is when
# the listing was ingested). Matches the Leads page "NEW" badge logic. Uses
# idx_activity_log_entity. Correlates on the un-aliased `inventory` table.
# Stage transitions are logged with action 'stage_change' (single-row PATCH +
# visit-schedule) or 'bulk_stage_change' (the bulk action bar). Both must be
# matched or bulk moves go uncounted.
_STAGE_CHANGE_ACTIONS = "('stage_change', 'bulk_stage_change')"


def _entered_today(stage: str) -> str:
    """SQL boolean: this inventory row's stage was changed INTO `stage` today
    (IST), per activity_log. Drives the "new vs old" split on the summary cards
    and the NEW badges. `stage` comes from a fixed set, never user input."""
    return (
        "EXISTS (SELECT 1 FROM activity_log al "
        "WHERE al.entity_type = 'inventory' AND al.entity_id = inventory.oh_id "
        f"AND al.action IN {_STAGE_CHANGE_ACTIONS} AND al.after_value = '{stage}' "
        f"AND (al.created_at AT TIME ZONE 'Asia/Kolkata')::DATE = {_TODAY_IST})"
    )


_QUALIFIED_TODAY = _entered_today("qualified")
_ACTIVE_TODAY = _entered_today("active")
_FOLLOW_UP_TODAY = _entered_today("follow_up")


def _visit_buckets(user) -> tuple[int, int]:
    """(to_be_completed, overdue) for rows currently in stage='visit_scheduled',
    bucketed by the property-DB scheduled visit date (see overdue_visit_ids).

    Overdue = scheduled date earlier than today (IST). Everything else still
    scheduled (today/future, or no date row yet) counts as "to be completed".
    The property read is guarded inside overdue_visit_ids, so a failure just
    yields overdue=0 rather than breaking the summary.
    """
    scope, scope_params = _scope_clause(user)
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"SELECT oh_id FROM inventory WHERE stage = 'visit_scheduled' {scope}",
                scope_params,
            )
            oh_ids = [r["oh_id"] for r in cur.fetchall()]
    finally:
        conn.close()

    if not oh_ids:
        return (0, 0)
    overdue = len(overdue_visit_ids(oh_ids))
    return (len(oh_ids) - overdue, overdue)


@bp.get("/summary")
@require_auth()
def summary():
    scope, scope_params = _scope_clause(g.user)
    where = f"WHERE TRUE {scope}"

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            # All summary-card counts in one conditional-aggregation pass.
            # "new" = entered the stage today (IST); for the intake 'lead' stage
            # that's created-today.
            cur.execute(
                f"""
                SELECT
                  COUNT(*) FILTER (WHERE stage = 'lead' AND {_CREATED_IST} = {_TODAY_IST}) AS lead_new,
                  COUNT(*) FILTER (WHERE stage = 'lead' AND {_CREATED_IST} < {_TODAY_IST}) AS lead_old,
                  COUNT(*) FILTER (WHERE stage = 'active' AND {_ACTIVE_TODAY}) AS active_new,
                  COUNT(*) FILTER (WHERE stage = 'active' AND NOT {_ACTIVE_TODAY}) AS active_old,
                  COUNT(*) FILTER (WHERE stage = 'qualified' AND {_QUALIFIED_TODAY}) AS qualified_new,
                  COUNT(*) FILTER (WHERE stage = 'qualified' AND NOT {_QUALIFIED_TODAY}) AS qualified_old,
                  COUNT(*) FILTER (WHERE stage = 'follow_up' AND {_FOLLOW_UP_TODAY}) AS follow_up_new,
                  COUNT(*) FILTER (WHERE stage = 'follow_up' AND NOT {_FOLLOW_UP_TODAY}) AS follow_up_old,

                  COUNT(*) FILTER (WHERE stage = 'rejected') AS rejected_total,

                  COUNT(*) FILTER (WHERE stage = 'pipeline') AS sup_pipeline,
                  COUNT(*) FILTER (WHERE stage = 'token_to_ama') AS sup_token_to_ama,
                  COUNT(*) FILTER (WHERE stage = 'onboarded') AS sup_onboarded,
                  COUNT(*) FILTER (WHERE stage = 'rejected_post_visit') AS sup_rejected_post_visit,
                  COUNT(*) FILTER (WHERE stage = 'cancelled_post_token') AS sup_cancelled_post_token,

                  -- Today's Task: denominator = leads created today (IST). Task 1
                  -- (lead→active) worked = created today & moved out of lead.
                  -- Task 2 (active→qualified) worked = created today & moved past active.
                  COUNT(*) FILTER (WHERE {_CREATED_IST} = {_TODAY_IST}) AS tt_total,
                  COUNT(*) FILTER (WHERE {_CREATED_IST} = {_TODAY_IST} AND stage <> 'lead') AS tt_task1_worked,
                  COUNT(*) FILTER (WHERE {_CREATED_IST} = {_TODAY_IST} AND stage NOT IN ('lead','active')) AS tt_task2_worked
                FROM inventory
                {where}
                """,
                scope_params,
            )
            row = cur.fetchone()

            # Rejected breakdown by reason.
            cur.execute(
                f"""SELECT COALESCE(stage_reason, 'unspecified') AS reason, COUNT(*) AS n
                    FROM inventory
                    {where} AND stage = 'rejected'
                    GROUP BY COALESCE(stage_reason, 'unspecified')""",
                scope_params,
            )
            by_reason = {r["reason"]: r["n"] for r in cur.fetchall()}

        # Today's Task progress. Denominator = leads created today. Task 2's
        # worked count is only exposed once Task 1 is complete (gating); until
        # then it's null and the card is locked client-side.
        tt_total = row["tt_total"]
        tt_task1_worked = row["tt_task1_worked"]
        task1_done = tt_task1_worked >= tt_total
        # Task 2 is gated behind Task 1 for RMs/managers (card locked + worked
        # not computed). Admins are never gated, so always expose it for them.
        if task1_done or g.user["role"] == "admin":
            tt_task2_worked = row["tt_task2_worked"]
        else:
            tt_task2_worked = None

        supply = {
            "pipeline": row["sup_pipeline"],
            "token_to_ama": row["sup_token_to_ama"],
            "onboarded": row["sup_onboarded"],
            "rejected_post_visit": row["sup_rejected_post_visit"],
            "cancelled_post_token": row["sup_cancelled_post_token"],
        }
        # A completed visit progresses into the Supply Closure Tracker, so
        # "visits completed" = everything currently in those supply stages.
        visit_completed = sum(supply.values())
        visit_to_be_completed, visit_overdue = _visit_buckets(g.user)

        return jsonify({
            "leads": {
                "lead_new": row["lead_new"],
                "lead_old": row["lead_old"],
                "active_new": row["active_new"],
                "active_old": row["active_old"],
            },
            "qualified": {"new": row["qualified_new"], "old": row["qualified_old"]},
            "follow_up": {"new": row["follow_up_new"], "old": row["follow_up_old"]},
            "visit": {
                "completed": visit_completed,
                "to_be_completed": visit_to_be_completed,
                "overdue": visit_overdue,
            },
            "supply": supply,
            "rejected": {"total": row["rejected_total"], "by_reason": by_reason},
            "todays_task": {
                "leads": {"total": tt_total, "worked": tt_task1_worked},
                "active": {"total": tt_total, "worked": tt_task2_worked},
            },
        })
    finally:
        conn.close()


@bp.get("/task-tracking")
@require_auth("admin")
def task_tracking():
    """Admin-only: per-user Today's Task progress.

    For every active RM with at least one lead CREATED today (IST), report how
    many of those leads they've moved past 'lead' (Task 1: lead→active) and past
    'active' (Task 2: active→qualified). total = their leads created today.
    Multi-RM leads count toward each assignee. Admin sees all (no scope).

    A leading synthetic row (id 0, name 'UNASSIGNED') reports the same progress
    for today's leads that have NO RM assigned — so admins can spot unworked,
    unassigned intake. It's only included when there are such leads today.

    Response: { users: [{ id, name, email, role, total, task1_worked, task2_worked }] }
    """
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT u.id, u.name, u.email, u.role,
                       COUNT(*)                                            AS total,
                       COUNT(*) FILTER (WHERE i.stage <> 'lead')           AS task1_worked,
                       COUNT(*) FILTER (WHERE i.stage NOT IN ('lead','active')) AS task2_worked
                FROM inventory i
                JOIN LATERAL unnest(i.assigned_rm_ids) AS rm_id ON TRUE
                JOIN users u ON u.id = rm_id AND u.is_active = TRUE
                WHERE (i.created_at AT TIME ZONE 'Asia/Kolkata')::DATE = {_TODAY_IST}
                GROUP BY u.id, u.name, u.email, u.role
                ORDER BY u.name NULLS LAST, u.email
                """,
            )
            users = cur.fetchall()

            # Unassigned bucket: today's leads with no RM (empty/NULL array).
            cur.execute(
                f"""
                SELECT COUNT(*)                                          AS total,
                       COUNT(*) FILTER (WHERE stage <> 'lead')           AS task1_worked,
                       COUNT(*) FILTER (WHERE stage NOT IN ('lead','active')) AS task2_worked
                FROM inventory
                WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::DATE = {_TODAY_IST}
                  AND COALESCE(cardinality(assigned_rm_ids), 0) = 0
                """,
            )
            un = cur.fetchone()
    finally:
        conn.close()

    if un and un["total"]:
        users = [{
            "id": 0, "name": "UNASSIGNED", "email": None, "role": None,
            "unassigned": True,
            "total": un["total"],
            "task1_worked": un["task1_worked"],
            "task2_worked": un["task2_worked"],
        }, *users]
    return jsonify({"users": users})


@bp.get("/rm-stage-counts")
@require_auth("admin")
def rm_stage_counts():
    """Admin-only: per-RM lead counts broken down by stage (all-time).

    Multi-RM leads count toward each assignee (unnest of assigned_rm_ids).
    Response: { users: [{ id, name, email, role, total, counts: {stage: n} }] }
    """
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT u.id, u.name, u.email, u.role, i.stage, COUNT(*) AS n
                FROM inventory i
                JOIN LATERAL unnest(i.assigned_rm_ids) AS rm_id ON TRUE
                JOIN users u ON u.id = rm_id AND u.is_active = TRUE
                WHERE i.stage IS NOT NULL
                GROUP BY u.id, u.name, u.email, u.role, i.stage
                """,
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    users: dict = {}
    for r in rows:
        b = users.get(r["id"])
        if b is None:
            b = {"id": r["id"], "name": r["name"], "email": r["email"],
                 "role": r["role"], "total": 0, "counts": {}}
            users[r["id"]] = b
        b["counts"][r["stage"]] = r["n"]
        b["total"] += r["n"]

    ordered = sorted(users.values(), key=lambda u: (-u["total"], (u["name"] or u["email"] or "").lower()))
    return jsonify({"users": ordered})
