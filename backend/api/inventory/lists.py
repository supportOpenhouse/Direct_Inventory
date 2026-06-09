"""Inventory read + aggregate endpoints: list, societies, counts, notifications."""
from __future__ import annotations

import csv
import io

from flask import Response, g, jsonify, request

from ...db import get_conn, get_props_conn
from ...services.cp_match import annotate_cp_match
from ..auth import require_auth
from ._common import (
    ALL_STAGES,
    SUPPLY_STAGES,
    INVENTORY_WITH_PRICING_SQL,
    SORTABLE_FIELDS,
    _build_filters,
    _scope_clause,
    bp,
    overdue_visit_ids,
)


@bp.get("")
@require_auth()
def list_inventory():
    user = g.user
    args = request.args
    limit  = min(args.get("limit", 200, type=int), 1000)
    offset = args.get("offset", 0, type=int)

    scope, scope_params, base_filters, base_params, post_filters, post_params = \
        _build_filters(user, args, alias="i")

    conn = get_conn()
    try:
        inner_where = f"WHERE TRUE {scope} {' '.join(base_filters)}"
        outer_where = f"WHERE TRUE {' '.join(post_filters)}"

        # Sort. Default mode is 'smart' — a follow-up-driven triage order:
        #   bucket 0: follow-up due today (IST)
        #   bucket 1: overdue follow-up — Follow Up stage first, then Lead, then
        #             others; most recent follow-up date first within each
        #   bucket 2: future follow-up — nearest date first
        #   bucket 3: no follow-up date
        # Within any tied follow-up date, an UNWORKED lead (no activity_log row
        # other than the auto 'create') beats a worked one — new leads win on
        # date clashes. An explicit column-header sort is a pure column sort
        # with updated_at DESC only as the final tiebreaker.
        sort_field = (args.get("sort") or "smart").strip()
        if sort_field == "smart":
            today_ist = "(NOW() AT TIME ZONE 'Asia/Kolkata')::DATE"
            order_clause = (
                f"CASE WHEN follow_up_at IS NULL THEN 3 "
                f"     WHEN follow_up_at::DATE = {today_ist} THEN 0 "
                f"     WHEN follow_up_at::DATE < {today_ist} THEN 1 "
                f"     ELSE 2 END ASC, "
                # Stage order applies only inside the overdue bucket: Follow Up
                # first, then Lead, then the rest.
                f"CASE WHEN follow_up_at IS NOT NULL AND follow_up_at::DATE < {today_ist} "
                f"     THEN CASE stage WHEN 'follow_up' THEN 0 WHEN 'lead' THEN 1 ELSE 2 END "
                f"     ELSE 0 END ASC, "
                # Overdue: most recent follow-up date first.
                f"CASE WHEN follow_up_at IS NOT NULL AND follow_up_at::DATE < {today_ist} "
                f"     THEN follow_up_at END DESC NULLS LAST, "
                # Future: nearest follow-up date first.
                f"CASE WHEN follow_up_at IS NOT NULL AND follow_up_at::DATE > {today_ist} "
                f"     THEN follow_up_at END ASC NULLS LAST, "
                # Unworked beats worked: any activity_log row other than the
                # auto 'create' counts as work. Uses idx_activity_log_entity.
                f"CASE WHEN EXISTS ("
                f"    SELECT 1 FROM activity_log al "
                f"    WHERE al.entity_type = 'inventory' "
                f"      AND al.entity_id = oh_id "
                f"      AND al.action <> 'create'"
                f") THEN 1 ELSE 0 END ASC, "
                f"updated_at DESC"
            )
        else:
            sort_dir = "ASC" if (args.get("dir") or "").strip().lower() == "asc" else "DESC"
            sort_sql = SORTABLE_FIELDS.get(sort_field, SORTABLE_FIELDS["updated_at"])
            nulls_clause = "NULLS LAST" if sort_dir == "DESC" else "NULLS FIRST"
            order_clause = (
                f"{sort_sql} {sort_dir} {nulls_clause}, "
                "updated_at DESC"
            )

        # Opt-in flags: stamp each row with whether its stage was moved to a
        # given stage on today's IST date — drives the "NEW" badge on the Leads
        # Active pane (active_today) and the Qualified page (qualified_today).
        # Uses idx_activity_log_entity like the smart sort. The stage value comes
        # from this fixed map (never user input) so the column name is safe.
        STAGE_TODAY_FLAGS = {
            "annotate_qualified_today": "qualified",
            "annotate_active_today": "active",
        }
        qt_parts = []
        for param, stage_val in STAGE_TODAY_FLAGS.items():
            if (args.get(param) or "").strip().lower() in ("1", "true", "yes"):
                qt_parts.append(
                    ", EXISTS ("
                    "    SELECT 1 FROM activity_log al "
                    "    WHERE al.entity_type = 'inventory' AND al.entity_id = j.oh_id "
                    f"      AND al.action IN ('stage_change', 'bulk_stage_change') AND al.after_value = '{stage_val}' "
                    "      AND (al.created_at AT TIME ZONE 'Asia/Kolkata')::DATE "
                    "          = (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE"
                    f"  ) AS {stage_val}_today"
                )
        qt_select = "".join(qt_parts)

        list_sql = f"""
            SELECT j.*{qt_select} FROM ({INVENTORY_WITH_PRICING_SQL} {inner_where}) j
            {outer_where}
            ORDER BY {order_clause}
            LIMIT %s OFFSET %s
        """
        count_sql = f"""
            SELECT COUNT(*) AS n FROM ({INVENTORY_WITH_PRICING_SQL} {inner_where}) j
            {outer_where}
        """
        final_params = [*scope_params, *base_params, *post_params, limit, offset]
        count_params = [*scope_params, *base_params, *post_params]

        with conn, conn.cursor() as cur:
            cur.execute(list_sql, final_params)
            rows = cur.fetchall()
            cur.execute(count_sql, count_params)
            total = cur.fetchone()["n"]
        # Annotate each row with cp_match ('perfect' | 'partial' | None).
        # Failure here is non-fatal — rows already have cp_match=None.
        annotate_cp_match(rows)
        # Opt-in: flag visit_scheduled rows whose scheduled visit date is past
        # (from the property DB). Only runs when requested, to keep the hot list
        # path free of the cross-DB read elsewhere.
        if (args.get("annotate_visit_overdue") or "").strip().lower() in ("1", "true", "yes"):
            vs_ids = [r["oh_id"] for r in rows if r.get("stage") == "visit_scheduled"]
            overdue = overdue_visit_ids(vs_ids) if vs_ids else set()
            for r in rows:
                if r.get("stage") == "visit_scheduled":
                    r["visit_overdue"] = r["oh_id"] in overdue
        return jsonify({"items": rows, "total": total, "limit": limit, "offset": offset})
    finally:
        conn.close()


# Safety ceiling for the ids endpoint — far above any realistic selection.
_IDS_CAP = 50000


@bp.get("/ids")
@require_auth()
def list_inventory_ids():
    """Every oh_id matching the current filters/scope — powers 'Select All'
    across pages. Honors the same filters as the list but has NO 1000-row cap
    (capped at _IDS_CAP) and returns ids only, so it's cheap for huge sets.
    """
    user = g.user
    args = request.args
    scope, scope_params, base_filters, base_params, post_filters, post_params = \
        _build_filters(user, args, alias="i")
    inner_where = f"WHERE TRUE {scope} {' '.join(base_filters)}"

    conn = get_conn()
    try:
        if post_filters:
            # oh_price / variation filters reference the pricing LATERAL.
            outer_where = f"WHERE TRUE {' '.join(post_filters)}"
            sql = (f"SELECT j.oh_id FROM ({INVENTORY_WITH_PRICING_SQL} {inner_where}) j "
                   f"{outer_where} LIMIT %s")
            params = [*scope_params, *base_params, *post_params, _IDS_CAP]
        else:
            # No post-filters → skip the pricing join entirely.
            sql = f"SELECT i.oh_id FROM inventory i {inner_where} LIMIT %s"
            params = [*scope_params, *base_params, _IDS_CAP]
        with conn, conn.cursor() as cur:
            cur.execute(sql, params)
            ids = [r["oh_id"] for r in cur.fetchall()]
    finally:
        conn.close()
    return jsonify({"ids": ids, "capped": len(ids) >= _IDS_CAP})


# CSV export — columns and their headers, in order.
_EXPORT_COLS = [
    ("oh_id", "OH ID"), ("society", "Society"), ("locality", "Locality"),
    ("city", "City"), ("bedrooms", "BHK"), ("area_sqft", "Area (sqft)"),
    ("floor", "Floor"), ("tower", "Tower"), ("unit_no", "Unit No"),
    ("price", "Asking Price"), ("oh_price", "OH Price"), ("variation_pct", "Variation %"),
    ("stage", "Stage"), ("stage_reason", "Reason"),
    ("assigned_rms_str", "Assigned RM(s)"),
    ("seller_name", "Seller Name"), ("seller_phone", "Seller Phone"),
    ("source", "Source"), ("posting_date", "Posting Date"),
    ("created_at", "Created At"), ("listing_link", "Listing Link"),
]
_EXPORT_CAP = 100000


@bp.get("/export")
@require_auth()
def export_inventory():
    """CSV of every row matching the current filters/scope (no 1000-row cap).
    Honors the same filters as the list so the download mirrors the on-screen
    view across all pages, not just the visible one.
    """
    user = g.user
    args = request.args
    scope, scope_params, base_filters, base_params, post_filters, post_params = \
        _build_filters(user, args, alias="i")
    inner_where = f"WHERE TRUE {scope} {' '.join(base_filters)}"
    outer_where = f"WHERE TRUE {' '.join(post_filters)}"

    sql = f"""
        SELECT j.oh_id, j.society, j.locality, j.city, j.bedrooms, j.area_sqft,
               j.floor, j.tower, j.unit_no, j.price, j.oh_price,
               j.stage, j.stage_reason, j.assigned_rms, j.seller_name,
               j.seller_phone, j.source, j.posting_date, j.created_at, j.listing_link
        FROM ({INVENTORY_WITH_PRICING_SQL} {inner_where}) j
        {outer_where}
        ORDER BY j.created_at DESC
        LIMIT %s
    """
    params = [*scope_params, *base_params, *post_params, _EXPORT_CAP]

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
    finally:
        conn.close()

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([h for _, h in _EXPORT_COLS])
    for r in rows:
        price, oh = r.get("price"), r.get("oh_price")
        r["variation_pct"] = round((price - oh) / oh * 100, 1) if (price and oh) else ""
        r["assigned_rms_str"] = "; ".join(
            (a.get("name") or a.get("email") or "") for a in (r.get("assigned_rms") or [])
        )
        w.writerow(["" if r.get(k) is None else r.get(k) for k, _ in _EXPORT_COLS])

    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=inventory.csv"},
    )


@bp.get("/societies")
@require_auth()
def list_societies():
    """Society + locality master list for a given city.

    Used to populate the Add Inventory modal's Society dropdown. Pulls from the
    read-only properties.master_societies table. The logical city 'Noida'
    includes 'Greater Noida'.
    """
    city = (request.args.get("city") or "").strip()
    if not city:
        return jsonify({"items": []})

    cities = ["Noida", "Greater Noida"] if city == "Noida" else [city]

    conn = get_props_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """SELECT DISTINCT society_name AS society, locality
                   FROM master_societies
                   WHERE city = ANY(%s) AND society_name IS NOT NULL AND society_name <> ''
                   ORDER BY society_name""",
                (cities,),
            )
            rows = cur.fetchall()
        return jsonify({"items": rows})
    finally:
        conn.close()


@bp.get("/counts")
@require_auth()
def inventory_counts():
    """Per-stage counts (and grand total) honoring ALL current filters.

    Uses the same LATERAL-joined subquery as the list endpoint so variation
    filters and oh_price-dependent filters stay in sync between chips and rows.
    """
    user = g.user
    args = request.args
    # Stage chips should reflect "what would be in each column if the user clicked
    # that chip", so we ignore the active stage filter when computing per-stage counts.
    args_no_stage = {k: v for k, v in args.items() if k != "stage"}

    class _Args:
        def __init__(self, d): self.d = d
        def get(self, k, default=None, type=None):
            v = self.d.get(k, default)
            if type is not None and v not in (None, ""):
                try: return type(v)
                except (ValueError, TypeError): return default
            return v
    args_proxy = _Args(args_no_stage)

    scope, scope_params, base_filters, base_params, post_filters, post_params = \
        _build_filters(user, args_proxy, alias="i")

    inner_where = f"WHERE TRUE {scope} {' '.join(base_filters)}"
    outer_where = f"WHERE TRUE {' '.join(post_filters)}"

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""SELECT stage, COUNT(*) AS n FROM (
                       {INVENTORY_WITH_PRICING_SQL} {inner_where}
                   ) j {outer_where}
                   GROUP BY stage""",
                [*scope_params, *base_params, *post_params],
            )
            by_stage = {s: 0 for s in (*ALL_STAGES, *SUPPLY_STAGES)}
            for r in cur.fetchall():
                if r["stage"] in by_stage:
                    by_stage[r["stage"]] += r["n"]
            cur.execute(
                f"""SELECT COUNT(*) AS n FROM (
                       {INVENTORY_WITH_PRICING_SQL} {inner_where}
                   ) j {outer_where}""",
                [*scope_params, *base_params, *post_params],
            )
            total = cur.fetchone()["n"]
        return jsonify({"total": total, "by_stage": by_stage})
    finally:
        conn.close()


@bp.get("/notifications")
@require_auth()
def notifications():
    """Bell-icon payload: rows the user should look at today.

    Two buckets, both visibility-scoped:
      - new_items: created in the last 24 hours.
      - today_follow_ups: rows with follow_up_at = CURRENT_DATE (IST).
    """
    user = g.user
    scope, scope_params = _scope_clause(user)

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""SELECT oh_id, society, city, bedrooms, floor, source, created_at
                    FROM inventory
                    WHERE created_at >= NOW() - INTERVAL '24 hours' {scope}
                    ORDER BY created_at DESC
                    LIMIT 50""",
                scope_params,
            )
            new_items = cur.fetchall()

            cur.execute(
                f"""SELECT oh_id, society, city, bedrooms, floor,
                           seller_name, seller_phone, follow_up_at, stage
                    FROM inventory
                    WHERE follow_up_at = CURRENT_DATE {scope}
                    ORDER BY society
                    LIMIT 100""",
                scope_params,
            )
            today_follow_ups = cur.fetchall()
        return jsonify({
            "new_items": new_items,
            "today_follow_ups": today_follow_ups,
            "total": len(new_items) + len(today_follow_ups),
        })
    finally:
        conn.close()
