"""Read-only activity log endpoints + per-user reports.

Activity list is admin/manager only. Filters (all optional, AND-combined):
  q              — UID prefix/substring (matches activity_log.entity_id)
  action         — slug e.g. 'login', 'update', 'stage_change'
  entity_type    — 'auth' | 'inventory' | 'user' | 'sync' …
  actor_email    — exact match (or the 'apps-script:*' grouping sentinel)
  from / to      — ISO date inclusive (server time)
  sort, dir      — whitelisted sort

LEFT JOIN against users so we can show actor name alongside email.

The user-report endpoints count every action — each 'stage_change',
'bulk_stage_change', and 'note_added' row is one action (no dedup, no
mid-step collapsing). note_added rows are mapped to a synthetic 'note' stage.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from flask import Blueprint, g, jsonify, request

from ..db import get_conn
from .auth import require_auth

IST = timezone(timedelta(hours=5, minutes=30))

bp = Blueprint("activity", __name__, url_prefix="/api/activity")


SORTABLE = {
    "created_at":   "a.created_at",
    "entity_id":    "a.entity_id",
    "actor_email":  "a.actor_email",
    "action":       "a.action",
    "entity_type":  "a.entity_type",
}

HARD_LIMIT = 500   # the page caps here; FE shows a banner when total > limit


def _scope_clause(user: dict) -> tuple[str, list]:
    """Restrict managers to inventory activity in their cities. Admin sees all.

    City-list is expanded so 'Noida' includes 'Greater Noida' — matches the
    same convention used by inventory._scope_clause and the Noida city tab.
    """
    if user["role"] == "manager":
        cities = user.get("cities") or []
        if "Noida" in cities:
            cities = list(set(cities) | {"Greater Noida"})
        return (
            " AND (a.entity_type <> 'inventory' OR a.entity_id IN ("
            "    SELECT oh_id FROM inventory WHERE city = ANY(%s)"
            " ))",
            [cities],
        )
    return ("", [])


@bp.get("")
@require_auth("admin", "manager")
def list_activity():
    user = g.user
    args = request.args

    q = (args.get("q") or "").strip()
    action = (args.get("action") or "").strip()
    entity_type = (args.get("entity_type") or "").strip()
    actor_email = (args.get("actor_email") or "").strip()
    date_from = (args.get("from") or "").strip()
    date_to = (args.get("to") or "").strip()
    sort = (args.get("sort") or "created_at").strip()
    dir_ = "ASC" if (args.get("dir") or "").lower() == "asc" else "DESC"
    sort_sql = SORTABLE.get(sort, SORTABLE["created_at"])

    limit = min(args.get("limit", HARD_LIMIT, type=int), HARD_LIMIT)
    offset = args.get("offset", 0, type=int)

    where: list[str] = []
    params: list = []

    if q:
        # Free-text search across actor (name + email), action, category,
        # UID, the changed field, before/after values, and the details blob.
        like = f"%{q}%"
        where.append(
            "(a.entity_id ILIKE %s OR a.actor_email ILIKE %s OR u.name ILIKE %s "
            "OR a.action ILIKE %s OR a.entity_type ILIKE %s OR a.field ILIKE %s "
            "OR a.before_value ILIKE %s OR a.after_value ILIKE %s "
            "OR a.metadata::text ILIKE %s)"
        )
        params.extend([like] * 9)
    if action:
        where.append("a.action = %s")
        params.append(action)
    if entity_type:
        where.append("a.entity_type = %s")
        params.append(entity_type)
    if actor_email:
        # `apps-script:*` is the grouping sentinel from the filters endpoint
        # — matches every per-batch sync entry as one logical "Apps Script"
        # actor instead of forcing the user to filter to a specific batch.
        if actor_email == "apps-script:*":
            where.append("a.actor_email LIKE 'apps-script:%%'")
        else:
            where.append("a.actor_email = %s")
            params.append(actor_email)
    if date_from:
        where.append("a.created_at >= %s")
        params.append(date_from)
    if date_to:
        where.append("a.created_at < (%s::date + INTERVAL '1 day')")
        params.append(date_to)

    scope_sql, scope_params = _scope_clause(user)
    # Always start with WHERE TRUE so the scope's " AND ..." chains cleanly.
    where_sql = "WHERE TRUE " + "".join(f"AND {c} " for c in where) + scope_sql

    base_from = (
        "FROM activity_log a "
        "LEFT JOIN users u ON u.email = a.actor_email "
        f"{where_sql}"
    )

    list_sql = (
        "SELECT a.id, a.created_at, a.actor_email, u.name AS actor_name, "
        "       a.entity_type, a.entity_id, a.action, a.field, "
        "       a.before_value, a.after_value, a.metadata "
        f"{base_from} "
        f"ORDER BY {sort_sql} {dir_}, a.id DESC "
        "LIMIT %s OFFSET %s"
    )
    count_sql = f"SELECT COUNT(*) AS n {base_from}"

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(list_sql, [*params, *scope_params, limit, offset])
            rows = cur.fetchall()
            cur.execute(count_sql, [*params, *scope_params])
            total = cur.fetchone()["n"]
        return jsonify({"items": rows, "total": total, "limit": limit, "offset": offset})
    finally:
        conn.close()


@bp.get("/filters")
@require_auth("admin", "manager")
def filter_options():
    """Distinct values to populate the filter dropdowns on the page.

    Cheap enough to run on every page load — these tables are small.
    """
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT DISTINCT action FROM activity_log WHERE action IS NOT NULL ORDER BY action")
            actions = [r["action"] for r in cur.fetchall()]
            cur.execute("SELECT DISTINCT entity_type FROM activity_log WHERE entity_type IS NOT NULL ORDER BY entity_type")
            entity_types = [r["entity_type"] for r in cur.fetchall()]
            # Every Apps-Script batch posts under a distinct synthetic actor_email
            # (e.g. apps-script:direct-inventory:batch-5/77). Collapse them into a
            # single "Apps Script Sync" entry whose value is the sentinel
            # `apps-script:*`. The list endpoint special-cases that value.
            cur.execute(
                "SELECT DISTINCT a.actor_email AS email, u.name "
                "FROM activity_log a LEFT JOIN users u ON u.email = a.actor_email "
                "WHERE a.actor_email IS NOT NULL "
                "  AND a.actor_email NOT LIKE 'apps-script:%' "
                "ORDER BY a.actor_email"
            )
            actors = cur.fetchall()
            cur.execute(
                "SELECT 1 FROM activity_log WHERE actor_email LIKE 'apps-script:%' LIMIT 1"
            )
            if cur.fetchone():
                actors.append({"email": "apps-script:*", "name": "Apps Script Sync"})
        return jsonify({"actions": actions, "entity_types": entity_types, "actors": actors})
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# User Report endpoints.
#
# All share the same base set (_WINNERS_CTE): one row per countable action —
# every stage_change / bulk_stage_change / note_added the user performed. No
# dedup, so each hop and each note counts. Three aggregations are exposed on
# top of that base set:
#
#   /user-report          aggregate over (date range, optional users) → per
#                         user summary across the whole range.
#   /user-report/days     aggregate over (date range, one user) → per day
#                         summary for that user.
#   /user-report/leads    one user + one IST day → full lead detail
#                         (powers the drill-down modal).
#
# Apps-Script sync and Forms webhook are excluded everywhere — they are not
# human actions.
# ---------------------------------------------------------------------------


def _parse_ist_range(default_to_today: bool = True):
    """Parse from/to query params into IST date objects + UTC datetime bounds.

    Returns (date_from, date_to, start_utc, end_utc).
    Raises ValueError on bad input.
    """
    today_ist = datetime.now(IST).date()
    from_str = (request.args.get("from") or "").strip()
    to_str = (request.args.get("to") or "").strip()
    if from_str:
        date_from = datetime.strptime(from_str, "%Y-%m-%d").date()
    elif default_to_today:
        date_from = today_ist
    else:
        raise ValueError("from is required")
    if to_str:
        date_to = datetime.strptime(to_str, "%Y-%m-%d").date()
    else:
        date_to = date_from
    if date_to < date_from:
        raise ValueError("to must be on or after from")
    start_ist = datetime(date_from.year, date_from.month, date_from.day, tzinfo=IST)
    end_ist = datetime(date_to.year, date_to.month, date_to.day, tzinfo=IST) + timedelta(days=1)
    return date_from, date_to, start_ist.astimezone(timezone.utc), end_ist.astimezone(timezone.utc)


# Base SELECT — one row per countable action. Every stage change (single-row
# 'stage_change' or bulk 'bulk_stage_change') AND every 'note_added' counts as a
# distinct action. There is intentionally NO dedup: a lead moved through three
# stages in a day is three actions, not one, and mid-steps are no longer
# collapsed. Moves to 'lead' are counted too (every stage change is an action).
#
# note_added rows carry the note text in after_value, not a stage — they are
# mapped to the synthetic 'note' stage so they count toward `total` and render
# as their own pill without polluting real stage counts.
#
# The CTE name and column shape (actor_email, day, oh_id, from_stage,
# final_stage, last_change_at) are unchanged so every endpoint stays consistent.
_WINNERS_CTE = """
    WITH winners AS (
        SELECT
            a.actor_email,
            (a.created_at AT TIME ZONE 'Asia/Kolkata')::DATE AS day,
            a.entity_id          AS oh_id,
            a.before_value       AS from_stage,
            CASE WHEN a.action = 'note_added' THEN 'note' ELSE a.after_value END AS final_stage,
            a.created_at         AS last_change_at
        FROM activity_log a
        WHERE a.action IN ('stage_change', 'bulk_stage_change', 'note_added')
          AND a.entity_type = 'inventory'
          AND a.created_at >= %s
          AND a.created_at <  %s
          AND a.actor_email IS NOT NULL
          AND a.actor_email NOT LIKE 'apps-script:%%'
          AND a.actor_email <> 'system:forms-webhook'
          {extra_where}
    )
"""


def _parse_users_param():
    """Comma-separated `users=` -> list[str] or None."""
    raw = (request.args.get("users") or "").strip()
    if not raw:
        return None
    return [s.strip() for s in raw.split(",") if s.strip()]


def _manager_rm_emails(cur, manager_id):
    """Lowercased emails of the RMs that report to this manager."""
    cur.execute("SELECT LOWER(email) AS email FROM users WHERE manager = %s", (manager_id,))
    return {r["email"] for r in cur.fetchall() if r.get("email")}


def _resolve_report_email(cur):
    """Resolve the report subject email for the current user, enforcing access.

    Returns (email, err) — exactly one is meaningful:
      admin   -> requested email (or self if none); err is None
      manager -> self, or one of their RMs; err set (403 tuple) otherwise
      rm      -> always self; err is None
    `err`, when set, is a (response, status) tuple the caller should return.
    """
    role = g.user["role"]
    own = (g.user["email"] or "").strip().lower()
    requested = (request.args.get("email") or "").strip().lower()
    if role == "admin":
        return (requested or own, None)
    if role == "manager":
        if not requested or requested == own:
            return (own, None)
        cur.execute(
            "SELECT 1 FROM users WHERE LOWER(email) = %s AND manager = %s",
            (requested, g.user["id"]),
        )
        if not cur.fetchone():
            return (None, (jsonify({"error": "you can only view your own RMs' reports"}), 403))
        return (requested, None)
    return (own, None)  # rm — always self


@bp.get("/user-report")
@require_auth("admin", "manager", "rm")
def user_report():
    """Per-user summary across an IST date range.

    Query: from=YYYY-MM-DD, to=YYYY-MM-DD (both default to today IST),
           users=email1,email2 (optional filter).
    Admin sees every user; a manager sees only their own RMs; an RM
    sees only themselves.
    """
    try:
        date_from, date_to, start_utc, end_utc = _parse_ist_range()
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    emails = _parse_users_param()

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            if g.user["role"] == "manager":
                rm_emails = _manager_rm_emails(cur, g.user["id"])
                if emails:
                    emails = [e for e in emails if e.strip().lower() in rm_emails]
                else:
                    emails = list(rm_emails)
                if not emails:
                    return jsonify({
                        "from": date_from.isoformat(),
                        "to": date_to.isoformat(),
                        "users": [],
                    })
            elif g.user["role"] == "rm":
                emails = [(g.user["email"] or "").strip().lower()]

            extra_where = "AND a.actor_email = ANY(%s)" if emails else ""
            sql = (
                _WINNERS_CTE.format(extra_where=extra_where) +
                " SELECT w.actor_email, w.day, w.final_stage, w.oh_id, "
                "        u.name AS actor_name, u.role AS actor_role "
                " FROM winners w LEFT JOIN users u ON u.email = w.actor_email"
            )
            params: list = [start_utc, end_utc]
            if emails:
                params.append(emails)
            cur.execute(sql, params)
            rows = cur.fetchall()
    finally:
        conn.close()

    users: dict[str, dict] = {}
    for r in rows:
        email = r["actor_email"]
        bucket = users.get(email)
        if bucket is None:
            bucket = {
                "actor_email": email,
                "actor_name": r.get("actor_name"),
                "actor_role": r.get("actor_role"),
                "total": 0,
                "counts": {},
                "_days": set(),
                "_oh_ids": set(),
            }
            users[email] = bucket
        bucket["total"] += 1
        stage = r["final_stage"] or "(none)"
        bucket["counts"][stage] = bucket["counts"].get(stage, 0) + 1
        bucket["_days"].add(r["day"])
        if r.get("oh_id"):
            bucket["_oh_ids"].add(r["oh_id"])
    for u in users.values():
        u["days_active"] = len(u.pop("_days"))
        u["unique_leads"] = len(u.pop("_oh_ids"))

    ordered = sorted(
        users.values(),
        key=lambda u: (-u["total"], (u["actor_name"] or u["actor_email"]).lower()),
    )
    return jsonify({
        "from": date_from.isoformat(),
        "to": date_to.isoformat(),
        "users": ordered,
    })


@bp.get("/user-report/analytics")
@require_auth("admin", "manager", "rm")
def user_report_analytics():
    """Daily trend aggregated across all selected users (or all users in scope).

    Same filters as /user-report (from, to, users). Adds the cross-user daily
    series and a strict period-cohort funnel.

    Response: {
      from, to,
      daily_trend: [{ day, total, counts: {stage: n}, by_user: {email: n} }],
      funnel: { qualified, visit_scheduled, visit_completed, offer_given },
      user_names: { email: name },
    }
    """
    try:
        date_from, date_to, start_utc, end_utc = _parse_ist_range()
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    emails = _parse_users_param()

    rows: list = []
    funnel_rows: list = []
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            if g.user["role"] == "manager":
                rm_emails = _manager_rm_emails(cur, g.user["id"])
                if emails:
                    emails = [e for e in emails if e.strip().lower() in rm_emails]
                else:
                    emails = list(rm_emails)
                if not emails:
                    return jsonify({
                        "from": date_from.isoformat(),
                        "to": date_to.isoformat(),
                        "daily_trend": [],
                        "funnel": {},
                    })
            elif g.user["role"] == "rm":
                emails = [(g.user["email"] or "").strip().lower()]

            extra_where = "AND a.actor_email = ANY(%s)" if emails else ""
            sql = (
                _WINNERS_CTE.format(extra_where=extra_where) +
                " SELECT w.day, w.final_stage, w.actor_email, "
                "        u.name AS actor_name "
                " FROM winners w LEFT JOIN users u ON u.email = w.actor_email"
            )
            params: list = [start_utc, end_utc]
            if emails:
                params.append(emails)
            cur.execute(sql, params)
            rows = cur.fetchall()

            # Funnel — strict period-dependent cohort.
            #
            # Cohort = leads created during the selected period that are
            # assigned to the filtered users. Lead count comes from
            # inventory.created_at (the assignment time for the common case),
            # NEVER from activity_log — a user moving a lead back to the intake
            # stage must not bump the new-lead count. For each subsequent
            # pipeline stage we count how many cohort leads ever reached it
            # (strict cohort → no >100% conversions).
            #
            # Multi-RM: a lead is in the cohort if ANY of its assigned_rm_ids
            # belongs to a filtered user.
            if emails:
                cohort_user_clause = (
                    "AND EXISTS ("
                    "  SELECT 1 FROM users u "
                    "  WHERE u.id = ANY(i.assigned_rm_ids) "
                    "    AND LOWER(u.email) = ANY(%s)"
                    ")"
                )
                cohort_params: list = [
                    start_utc, end_utc, [e.lower() for e in emails],
                ]
            else:
                cohort_user_clause = ""
                cohort_params = [start_utc, end_utc]

            cur.execute(
                "SELECT COUNT(*) AS leads FROM inventory i "
                "WHERE i.created_at >= %s AND i.created_at < %s "
                f"  {cohort_user_clause}",
                cohort_params,
            )
            qualified_count = cur.fetchone()["leads"]

            cur.execute(
                "WITH cohort AS ("
                "  SELECT i.oh_id FROM inventory i "
                "  WHERE i.created_at >= %s AND i.created_at < %s "
                f"    {cohort_user_clause}"
                ") "
                "SELECT a.after_value AS stage, "
                "       COUNT(DISTINCT a.entity_id) AS leads "
                "FROM activity_log a "
                "WHERE a.action = 'stage_change' "
                "  AND a.entity_type = 'inventory' "
                "  AND a.after_value IN ('visit_scheduled', 'visit_completed', 'offer_given') "
                "  AND a.entity_id IN (SELECT oh_id FROM cohort) "
                "GROUP BY a.after_value",
                cohort_params,
            )
            funnel_rows = cur.fetchall()
    finally:
        conn.close()

    days: dict = {}
    user_names: dict = {}
    for r in rows:
        d = r["day"]
        bucket = days.get(d)
        if bucket is None:
            bucket = {"day": d.isoformat(), "total": 0, "counts": {}, "by_user": {}}
            days[d] = bucket
        bucket["total"] += 1
        stage = r["final_stage"] or "(none)"
        bucket["counts"][stage] = bucket["counts"].get(stage, 0) + 1
        email = r["actor_email"]
        bucket["by_user"][email] = bucket["by_user"].get(email, 0) + 1
        if r.get("actor_name"):
            user_names[email] = r["actor_name"]

    ordered = sorted(days.values(), key=lambda d: d["day"])
    funnel = {r["stage"]: r["leads"] for r in funnel_rows}
    funnel["qualified"] = qualified_count
    return jsonify({
        "from": date_from.isoformat(),
        "to": date_to.isoformat(),
        "daily_trend": ordered,
        "funnel": funnel,
        "user_names": user_names,
    })


@bp.get("/user-report/days")
@require_auth("admin", "manager", "rm")
def user_report_days():
    """Per-day summary for a single user across an IST date range.

    Query: email (required), from, to (both default to today IST).
    Access: admin → any user; manager → themselves or one of their RMs;
    rm → only themselves.
    """
    try:
        date_from, date_to, start_utc, end_utc = _parse_ist_range()
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    sql = (
        _WINNERS_CTE.format(extra_where="AND a.actor_email = %s") +
        " SELECT w.day, w.final_stage, w.oh_id, "
        "        u.name AS actor_name, u.role AS actor_role "
        " FROM winners w LEFT JOIN users u ON u.email = w.actor_email"
    )
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            email, err = _resolve_report_email(cur)
            if err:
                return err
            if not email:
                return jsonify({"error": "email is required"}), 400
            cur.execute(sql, (start_utc, end_utc, email))
            rows = cur.fetchall()
    finally:
        conn.close()

    days: dict = {}
    actor_name = None
    actor_role = None
    unique_oh_ids: set = set()
    for r in rows:
        actor_name = actor_name or r.get("actor_name")
        actor_role = actor_role or r.get("actor_role")
        d = r["day"]
        bucket = days.get(d)
        if bucket is None:
            bucket = {"day": d.isoformat(), "total": 0, "counts": {}}
            days[d] = bucket
        bucket["total"] += 1
        stage = r["final_stage"] or "(none)"
        bucket["counts"][stage] = bucket["counts"].get(stage, 0) + 1
        if r.get("oh_id"):
            unique_oh_ids.add(r["oh_id"])

    ordered = sorted(days.values(), key=lambda d: d["day"], reverse=True)
    return jsonify({
        "email": email,
        "actor_name": actor_name,
        "actor_role": actor_role,
        "from": date_from.isoformat(),
        "to": date_to.isoformat(),
        "unique_leads": len(unique_oh_ids),
        "days": ordered,
    })


@bp.get("/user-report/leads")
@require_auth("admin", "manager", "rm")
def user_report_leads():
    """Full lead detail for one user on one IST day. Powers the drill-down modal.

    Query: email (required), date=YYYY-MM-DD (required).
    Access: admin → any user; manager → themselves or one of their RMs;
    rm → only themselves.
    """
    date_str = (request.args.get("date") or "").strip()
    if not date_str:
        return jsonify({"error": "email and date are required"}), 400
    try:
        day_ist = datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        return jsonify({"error": "invalid date; expected YYYY-MM-DD"}), 400

    start_ist = datetime(day_ist.year, day_ist.month, day_ist.day, tzinfo=IST)
    end_ist = start_ist + timedelta(days=1)
    start_utc = start_ist.astimezone(timezone.utc)
    end_utc = end_ist.astimezone(timezone.utc)

    sql = (
        _WINNERS_CTE.format(extra_where="AND a.actor_email = %s") +
        " SELECT w.oh_id, w.from_stage, w.final_stage, w.last_change_at, "
        "        i.society, i.city, i.seller_name, "
        "        i.stage AS current_stage, i.stage_reason, "
        # Latest note authored ON this IST day (note_thread carries UTC
        # timestamps; the day's start/end UTC bounds delimit the IST calendar day).
        "        ( SELECT jsonb_build_object("
        "                   'body', n->>'body', 'author_name', n->>'author_name', "
        "                   'author_email', n->>'author_email', 'created_at', n->>'created_at') "
        "          FROM jsonb_array_elements(COALESCE(i.note_thread, '[]'::jsonb)) AS n "
        "          WHERE (n->>'created_at')::timestamptz >= %s "
        "            AND (n->>'created_at')::timestamptz <  %s "
        "          ORDER BY (n->>'created_at')::timestamptz DESC LIMIT 1 ) AS day_note "
        " FROM winners w LEFT JOIN inventory i ON i.oh_id = w.oh_id "
        " ORDER BY w.last_change_at DESC"
    )
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            email, err = _resolve_report_email(cur)
            if err:
                return err
            if not email:
                return jsonify({"error": "email and date are required"}), 400
            cur.execute(sql, (start_utc, end_utc, email, start_utc, end_utc))
            rows = cur.fetchall()
    finally:
        conn.close()
    return jsonify({"email": email, "date": day_ist.isoformat(), "leads": rows})
