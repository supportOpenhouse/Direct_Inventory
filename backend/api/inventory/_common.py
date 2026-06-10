"""Shared blueprint, constants and query helpers for the inventory endpoints.

The inventory API is split into focused modules that all hang off the single
blueprint defined here:

  lists.py        — list, counts, societies, notifications  (read/aggregate)
  records.py      — get one, visible-rms, create, notes, patch  (single row)
  bulk.py         — bulk-update, assigned-rms  (multi-row / admin)
  maintenance.py  — cp-match-scan, assign-missing  (background jobs)

Visibility:
  - admin     : sees everything
  - manager   : sees rows in their cities
  - rm        : sees only rows where the user is in `assigned_rm_ids`. POCs are
                persisted on the row by services.assignment.assign_missing_batch
                (POST /api/inventory/assign-missing). Multi-RM supported.

Stages (Leads board order):
  lead → qualified → call_not_received → follow_up → visit_scheduled → rejected
  `lead` is unacted intake (Leads page left column); `qualified` is acted-on.
"""
from __future__ import annotations

import logging

from flask import Blueprint

from ...db import get_props_conn

bp = Blueprint("inventory", __name__, url_prefix="/api/inventory")

log = logging.getLogger(__name__)

# Property-DB source for scheduled visit dates: cp_inventory_status (the table
# supply-sync reads), joined cp_id = inventory.oh_id. The column is free TEXT
# (default ''), holding an ISO 'YYYY-MM-DD' date (what our scheduler writes via
# datetime.fromisoformat). Change these if the column/table differs.
VISIT_TABLE = "cp_inventory_status"
VISIT_JOIN_COL = "cp_id"
VISIT_DATE_COL = "visit_scheduled_date"
_ISO_DATE_RE = r"^\d{4}-\d{2}-\d{2}"


def overdue_visit_ids(oh_ids):
    """Subset of `oh_ids` whose scheduled visit date in the property DB is a
    valid ISO date earlier than today (IST) — i.e. the visit is overdue.

    ISO date text sorts chronologically, so we compare lexically (no ::date cast
    that could choke on the column's '' default or malformed rows). Guarded:
    returns an empty set on any property-DB failure (e.g. column not added yet)
    so callers degrade gracefully.
    """
    ids = [i for i in oh_ids if i]
    if not ids:
        return set()
    try:
        pconn = get_props_conn()
        try:
            with pconn, pconn.cursor() as pcur:
                pcur.execute(
                    f"SELECT DISTINCT TRIM({VISIT_JOIN_COL}) AS cp FROM {VISIT_TABLE} "
                    f"WHERE TRIM({VISIT_JOIN_COL}) = ANY(%s) "
                    f"  AND TRIM({VISIT_DATE_COL}) ~ %s "
                    f"  AND TRIM({VISIT_DATE_COL}) < to_char((NOW() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD')",
                    (ids, _ISO_DATE_RE),
                )
                return {r["cp"] for r in pcur.fetchall()}
        finally:
            pconn.close()
    except Exception:
        log.warning("overdue_visit_ids: property-DB read failed", exc_info=True)
        return set()

VALID_STAGES = {
    # Lead flow, in order:
    #   lead -> active -> qualified -> {call_not_received, follow_up,
    #                                   visit_scheduled, rejected}
    # `lead` is the raw intake stage; `active` is a lead being worked; `qualified`
    # is one that's been qualified.
    "lead",                  # intake — Leads page left column
    "active",                # active lead — Leads page right column
    "qualified",             # qualified — Qualified Leads page
    "call_not_received",     # CNR — first attempt failed
    "follow_up",             # ongoing conversation
    "visit_scheduled",
    "rejected",
    # Supply Closure Tracker stages — post-visit acquisition funnel, synced from
    # PROPERTIES_DB.cp_inventory_status (direct_stage). Live alongside the lead
    # stages; shown only on the tracker page.
    "pipeline",
    "token_to_ama",
    "onboarded",
    "rejected_post_visit",
    "cancelled_post_token",
    # Legacy stages — no longer shown on the kanban, but still accepted so the
    # Forms webhook (visit completed/cancelled/rescheduled flow) keeps working
    # and historical rows in these stages can be moved out manually if needed.
    "visit_completed",
    "offer_given",
    "unreachable",
}

# Lead-board stages, in display order. Drives count chips + the counts endpoint.
ALL_STAGES = [
    "lead", "active", "qualified", "call_not_received", "follow_up", "visit_scheduled", "rejected",
]

# Supply Closure Tracker stages, in funnel order.
SUPPLY_STAGES = [
    "pipeline", "token_to_ama", "onboarded", "rejected_post_visit", "cancelled_post_token",
]

# Whitelist of fields the client can sort by. Maps the API name → SQL fragment.
# Variation is computed (asking - oh_price) / oh_price; everything else is a column.
SORTABLE_FIELDS = {
    "oh_id":         "oh_id",
    "city":          "city",
    "rm_name":       "rm_name",
    "society":       "society",
    "bedrooms":      "bedrooms",
    "floor":         "floor",
    "area_sqft":     "area_sqft",
    "price":         "price",
    "oh_price":      "oh_price",
    "variation":     "CASE WHEN oh_price IS NULL OR oh_price = 0 THEN NULL "
                     "ELSE (price::FLOAT - oh_price) / oh_price * 100 END",
    # Stage sorts in pipeline order, not alphabetically.
    "stage":         "CASE stage WHEN 'lead' THEN 0 "
                     "WHEN 'active' THEN 1 WHEN 'qualified' THEN 2 "
                     "WHEN 'call_not_received' THEN 3 WHEN 'follow_up' THEN 4 "
                     "WHEN 'visit_scheduled' THEN 5 WHEN 'rejected' THEN 6 ELSE 7 END",
    "seller_name":   "seller_name",
    "seller_phone":  "seller_phone",
    "posting_date":  "posting_date",
    "created_at":    "created_at",
    "follow_up_at":  "follow_up_at",
    "notes":         "notes",
    "updated_at":    "updated_at",
}

# Reject reasons written to inventory.stage_reason alongside stage='rejected'.
# The backend accepts the UNION of two context-specific sets the frontend shows:
#   - rejecting an intake lead (stage 'lead', the "Lead" board) uses the
#     listing-quality reasons (ground_floor / listing_removed /
#     invalid_duplicate);
#   - rejecting from a worked stage (call_not_received / follow_up /
#     visit_scheduled) uses the engagement reasons, which are the values already
#     present in the live DB.
# Note: a duplicate listing uses the SAME `invalid_duplicate` value in both
# contexts (the older `duplicate` value was folded into it) so it counts as one
# category in breakdowns/reports.
LEADS_REJECT_REASONS = {
    "ground_floor",
    "listing_removed",
    "invalid_duplicate",
}
WORKED_REJECT_REASONS = {
    "not_interested",
    "invalid_duplicate",
    "future_prospect",
    "oh_rejected",
    "sold",
    "broker_listing",
}
# Contact-quality reasons surfaced when rejecting from the 'active' stage (the
# seller couldn't be reached). Mirrors ACTIVE_REJECT_REASONS in the frontend.
ACTIVE_REJECT_REASONS = {
    "number_not_found",
    "invalid_number",
}
VALID_REJECT_REASONS = LEADS_REJECT_REASONS | WORKED_REJECT_REASONS | ACTIVE_REJECT_REASONS

EDITABLE_RAW_FIELDS = {
    "source", "city", "locality", "society", "bedrooms", "area_sqft",
    "floor", "tower", "unit_no",
    "price", "seller_name", "seller_phone", "posting_date", "listing_link",
}

# Fields that bulk-update may set. Single-row PATCH allows more (notes, raw fields).
BULK_ALLOWED_FIELDS = {
    "stage", "stage_reason", "assigned_rm_ids", "assigned_mgr_id", "follow_up_at",
    "priority",
}

# Standard BHK options offered in the UI. The BHK filter's "Other" bucket matches
# anything outside this set. Keep in sync with the FilterPanel BHK pills.
STANDARD_BHKS = [1, 2, 2.5, 3, 3.5, 4, 5]

# Roles allowed to flag a lead as Priority / set star_color.
PRIORITY_ROLES = {"admin", "manager", "rm"}


def _expand_cities(cities: list[str]) -> list[str]:
    """The city-tab convention: the logical city 'Noida' includes 'Greater Noida'
    in the DB. Without this, an RM/manager scoped to 'Noida' would silently miss
    every 'Greater Noida' row even though the Noida tab shows them.
    """
    expanded = set(cities)
    if "Noida" in expanded:
        expanded.add("Greater Noida")
    return list(expanded)


def _scope_clause(user: dict, alias: str = "") -> tuple[str, list]:
    """Return (sql_where_fragment, params) for visibility filtering.

    Roles:
      admin    — sees everything.
      manager  — sees rows in their assigned cities (empty cities → nothing;
                 'Noida' expands to include 'Greater Noida').
      rm       — sees only rows where the user is in `assigned_rm_ids`.

    `alias` is the optional table alias prefix (e.g. 'i' if the query uses
    `inventory i`).
    """
    p = f"{alias}." if alias else ""
    if user["role"] == "admin":
        return ("", [])
    if user["role"] == "manager":
        cities = user.get("cities") or []
        if not cities:
            return ("AND FALSE", [])
        return (f"AND {p}city = ANY(%s)", [_expand_cities(cities)])
    # rm
    return (f"AND %s = ANY({p}assigned_rm_ids)", [user["id"]])


def _build_filters(user: dict, args, alias: str = ""):
    """Parse query string into:
       (scope_sql, scope_params, base_filters, base_params, post_filters, post_params)

    `base_filters` use inventory columns only (so they work in the COUNT subquery
    and inside the LATERAL-joined SELECT). `post_filters` reference the LATERAL
    result (oh_price, variation) and must be applied as an outer wrapper.

    `alias` is the table alias for the inventory rows in the base filters
    ('i' inside the SELECT, '' inside a wrapping subquery).
    """
    p = f"{alias}." if alias else ""
    scope, scope_params = _scope_clause(user, alias=alias)
    base_filters: list[str] = []
    base_params: list = []

    stage    = args.get("stage")
    city     = args.get("city")
    q        = (args.get("q") or "").strip()
    society  = (args.get("society") or "").strip()
    locality = (args.get("locality") or "").strip()
    bhk_csv  = args.get("bhk")
    price_min = args.get("price_min", type=int)
    price_max = args.get("price_max", type=int)
    posting_from = (args.get("posting_from") or "").strip()
    posting_to   = (args.get("posting_to") or "").strip()
    source       = (args.get("source") or "").strip()

    if stage:
        # Comma-separated list → IN (...). Single value still works because
        # split on ',' returns [stage].
        stages = [s.strip() for s in stage.split(",") if s.strip()]
        if len(stages) == 1:
            base_filters.append(f"AND {p}stage = %s")
            base_params.append(stages[0])
        elif stages:
            base_filters.append(f"AND {p}stage = ANY(%s)")
            base_params.append(stages)
    if city:
        if city == "Noida":
            base_filters.append(f"AND {p}city IN ('Noida', 'Greater Noida')")
        else:
            base_filters.append(f"AND {p}city = %s")
            base_params.append(city)
    # Reason filter (stage_reason) — comma-separated → IN (...). Powers the
    # Rejected board's reason filter.
    reason = (args.get("reason") or "").strip()
    if reason:
        reasons = [r.strip() for r in reason.split(",") if r.strip()]
        if len(reasons) == 1:
            base_filters.append(f"AND {p}stage_reason = %s")
            base_params.append(reasons[0])
        elif reasons:
            base_filters.append(f"AND {p}stage_reason = ANY(%s)")
            base_params.append(reasons)
    # RM filter — direct array membership now that a property can have multiple
    # RMs assigned (assigned_rm_ids INT[]).
    #   'none'     → rows with no POC assigned (empty array).
    #   'multiple' → rows with more than one RM assigned.
    #   '<int>'    → rows where that RM is one of the assignees.
    rm_id = (args.get("rm_id") or "").strip()
    if rm_id == "none":
        base_filters.append(f"AND cardinality({p}assigned_rm_ids) = 0")
    elif rm_id == "multiple":
        base_filters.append(f"AND cardinality({p}assigned_rm_ids) > 1")
    elif rm_id.isdigit():
        base_filters.append(f"AND %s = ANY({p}assigned_rm_ids)")
        base_params.append(int(rm_id))

    # Multi-RM filter — comma-separated ids → rows assigned to ANY of them.
    rm_ids_raw = (args.get("rm_ids") or "").strip()
    if rm_ids_raw:
        rm_ids = [int(x) for x in rm_ids_raw.split(",") if x.strip().isdigit()]
        if rm_ids:
            base_filters.append(f"AND {p}assigned_rm_ids && %s")
            base_params.append(rm_ids)
    if q:
        # Substring ("half") search: each whitespace-separated token must appear
        # case-insensitively, anywhere, in at least one searchable column — so a
        # single box like "1003 d2 sahaj" matches a row whose unit_no=1003,
        # tower=D2, seller_name=Sahaj (token-AND, field-OR). Numeric columns are
        # cast to text so "1200" matches an area. LIKE wildcards (% _ \) in the
        # token are escaped so they match literally.
        text_cols = [
            "oh_id", "society", "seller_name", "seller_phone", "locality",
            "city", "source", "unit_no", "tower", "floor", "listing_link",
        ]
        num_cols = ["bedrooms", "area_sqft"]
        for tok in q.split():
            esc = tok.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            like = f"%{esc}%"
            clauses = [f"{p}{c} ILIKE %s" for c in text_cols]
            clauses += [f"{p}{c}::text ILIKE %s" for c in num_cols]
            base_filters.append("AND (" + " OR ".join(clauses) + ")")
            base_params.extend([like] * (len(text_cols) + len(num_cols)))
    if society:
        # Comma-separated list of canonical society names from the filter UI.
        # Match case-insensitively to absorb minor casing/whitespace drift.
        names = [s.strip().lower() for s in society.split(",") if s.strip()]
        if names:
            base_filters.append(f"AND LOWER(TRIM({p}society)) = ANY(%s)")
            base_params.append(names)
    if locality:
        names = [s.strip().lower() for s in locality.split(",") if s.strip()]
        if names:
            base_filters.append(f"AND LOWER(TRIM({p}locality)) = ANY(%s)")
            base_params.append(names)
    if bhk_csv:
        tokens = [x.strip() for x in bhk_csv.split(",") if x.strip()]
        want_other = any(t.lower() == "other" for t in tokens)
        try:
            nums = [float(t) for t in tokens if t.lower() != "other"]
        except ValueError:
            nums = []
        conds, cond_params = [], []
        if nums:
            conds.append(f"{p}bedrooms = ANY(%s)")
            cond_params.append(nums)
        if want_other:
            # Anomalies: a BHK value present but outside the standard options.
            conds.append(f"({p}bedrooms IS NOT NULL AND {p}bedrooms <> ALL(%s))")
            cond_params.append(STANDARD_BHKS)
        if conds:
            base_filters.append("AND (" + " OR ".join(conds) + ")")
            base_params.extend(cond_params)
    if price_min is not None:
        base_filters.append(f"AND {p}price >= %s")
        base_params.append(price_min)
    if price_max is not None:
        base_filters.append(f"AND {p}price <= %s")
        base_params.append(price_max)
    if posting_from:
        base_filters.append(f"AND {p}posting_date >= %s")
        base_params.append(posting_from)
    if posting_to:
        base_filters.append(f"AND {p}posting_date <= %s")
        base_params.append(posting_to)
    # "Empty" preset on the Date posted chip row — rows with no posting_date.
    if str(args.get("posting_empty") or "").strip() in ("1", "true", "yes"):
        base_filters.append(f"AND {p}posting_date IS NULL")
    follow_up_from = (args.get("follow_up_from") or "").strip()
    follow_up_to   = (args.get("follow_up_to") or "").strip()
    if follow_up_from:
        base_filters.append(f"AND {p}follow_up_at >= %s")
        base_params.append(follow_up_from)
    if follow_up_to:
        base_filters.append(f"AND {p}follow_up_at <= %s")
        base_params.append(follow_up_to)
    if str(args.get("follow_up_empty") or "").strip() in ("1", "true", "yes"):
        base_filters.append(f"AND {p}follow_up_at IS NULL")
    if source:
        base_filters.append(f"AND {p}source = %s")
        base_params.append(source)

    # No-phone / has-phone filters on seller_phone (mutually exclusive in the UI).
    if str(args.get("no_phone") or "").strip().lower() in ("1", "true", "yes"):
        base_filters.append(f"AND ({p}seller_phone IS NULL OR TRIM({p}seller_phone) = '')")
    if str(args.get("has_phone") or "").strip().lower() in ("1", "true", "yes"):
        base_filters.append(f"AND {p}seller_phone IS NOT NULL AND TRIM({p}seller_phone) <> ''")

    priority_raw = args.get("priority")
    if priority_raw not in (None, ""):
        # Accept 1/0, true/false, yes/no. Default to TRUE when the param is just `?priority`.
        truthy = str(priority_raw).strip().lower() in ("1", "true", "yes", "")
        if truthy:
            base_filters.append(f"AND {p}priority = TRUE")

    # Star filter. Comma-separated list of effective star categories. The CASE
    # mirrors the frontend starColor() resolution: explicit star_color override
    # wins, then priority, then cp_match.
    star = args.get("star")
    if star:
        valid_stars = {"partial", "perfect", "important", "blank"}
        stars = [s for s in (x.strip().lower() for x in star.split(",")) if s in valid_stars]
        if stars:
            base_filters.append(
                f"AND (CASE "
                f"WHEN {p}star_color = 'yellow' THEN 'important' "
                f"WHEN {p}star_color = 'green'  THEN 'perfect' "
                f"WHEN {p}star_color = 'red'    THEN 'partial' "
                f"WHEN {p}star_color = 'none'   THEN 'blank' "
                f"WHEN {p}priority THEN 'important' "
                f"WHEN {p}cp_match = 'perfect'  THEN 'perfect' "
                f"WHEN {p}cp_match = 'partial'  THEN 'partial' "
                f"ELSE 'blank' END) = ANY(%s)"
            )
            base_params.append(stars)

    # Variation = (asking - oh) / oh * 100. Requires oh_price from the LATERAL.
    post_filters: list[str] = []
    post_params: list = []
    variation_min = args.get("variation_min", type=float)
    variation_max = args.get("variation_max", type=float)
    if variation_min is not None:
        post_filters.append("AND oh_price IS NOT NULL AND oh_price > 0 "
                            "AND ((price::FLOAT - oh_price) / oh_price * 100) >= %s")
        post_params.append(variation_min)
    if variation_max is not None:
        post_filters.append("AND oh_price IS NOT NULL AND oh_price > 0 "
                            "AND ((price::FLOAT - oh_price) / oh_price * 100) <= %s")
        post_params.append(variation_max)

    # OH Price match filter — also references the LATERAL result.
    #   missing -> "Check Price" rows (no strict oh_pricing match)
    #   matched -> rows with a real oh_price.
    oh_price_f = (args.get("oh_price") or "").strip().lower()
    if oh_price_f == "missing":
        post_filters.append("AND oh_price IS NULL")
    elif oh_price_f == "matched":
        post_filters.append("AND oh_price IS NOT NULL")

    return scope, scope_params, base_filters, base_params, post_filters, post_params


# Common subquery: inventory + best-matching OH Pricing row, with match_kind.
# We always wrap this in an outer SELECT so variation filters (which reference
# oh_price) can be applied uniformly across list / counts / count_total.
# OH Price = a strict lookup into the manually-maintained oh_pricing sheet, NOT a
# computed/per-sqft number. A listing gets a price only when ALL hold:
#   1. society  — exact (LOWER(TRIM(society)) = op.society_norm)
#   2. bhk      — exact (op.bhk = i.bedrooms)
#   3. area     — within ±50 sqft (hard cliff)
# LATERAL `p` is that strict match (sets oh_price; closest area wins). LATERAL `d`
# is diagnostics only — the nearest priced (society+bhk) row IGNORING the ±50 gate
# — and NEVER sets the price; it powers oh_near_diff and the area_off reason.
# oh_price_reason: match | no_area | area_off | no_match (see OH Price handover).
OH_AREA_TOLERANCE = 50

INVENTORY_WITH_PRICING_SQL = f"""
    SELECT i.*,
           p.acq_price    AS oh_price,
           p.area_sqft    AS oh_price_area,
           p.bhk          AS oh_price_bhk,
           'exact'        AS oh_price_match,
           CASE
             WHEN p.acq_price IS NOT NULL THEN 'match'
             WHEN i.area_sqft IS NULL     THEN 'no_area'
             WHEN d.acq_price IS NOT NULL THEN 'area_off'
             ELSE 'no_match'
           END            AS oh_price_reason,
           d.near_diff    AS oh_near_diff,
           COALESCE(
               (SELECT json_agg(
                           json_build_object('id', u.id, 'name', u.name, 'email', u.email)
                           ORDER BY u.id
                       )
                FROM users u
                WHERE u.id = ANY(i.assigned_rm_ids)),
               '[]'::json
           ) AS assigned_rms
    FROM inventory i
    LEFT JOIN LATERAL (
        -- Strict match: society + exact BHK + area within ±{OH_AREA_TOLERANCE} sqft.
        SELECT op.acq_price, op.area_sqft, op.bhk
        FROM oh_pricing op
        WHERE op.society_norm = LOWER(TRIM(i.society))
          AND op.acq_price IS NOT NULL
          AND op.bhk = i.bedrooms
          AND i.area_sqft IS NOT NULL AND op.area_sqft IS NOT NULL
          AND ABS(op.area_sqft - i.area_sqft) <= {OH_AREA_TOLERANCE}
        ORDER BY ABS(op.area_sqft - i.area_sqft)
        LIMIT 1
    ) p ON TRUE
    LEFT JOIN LATERAL (
        -- Diagnostic: nearest priced (society + BHK) row, ignoring the ±{OH_AREA_TOLERANCE} gate.
        -- Tells area_off (a price exists) from no_match, and gives the sqft gap.
        SELECT op.acq_price,
               CASE WHEN op.area_sqft IS NOT NULL AND i.area_sqft IS NOT NULL
                    THEN ABS(op.area_sqft - i.area_sqft) END AS near_diff
        FROM oh_pricing op
        WHERE op.society_norm = LOWER(TRIM(i.society))
          AND op.acq_price IS NOT NULL
          AND op.bhk = i.bedrooms
        ORDER BY (CASE WHEN op.area_sqft IS NULL OR i.area_sqft IS NULL
                       THEN 9999 ELSE ABS(op.area_sqft - i.area_sqft) END)
        LIMIT 1
    ) d ON TRUE
"""

# Selects one inventory row with its assigned_rms json, in the same shape the
# list endpoint emits, so the frontend can patch its cached item.
ONE_WITH_RMS_SQL = (
    "SELECT i.*, COALESCE("
    "  (SELECT json_agg("
    "      json_build_object('id', u.id, 'name', u.name, 'email', u.email)"
    "      ORDER BY u.id"
    "   ) FROM users u WHERE u.id = ANY(i.assigned_rm_ids)),"
    "  '[]'::json"
    ") AS assigned_rms "
    "FROM inventory i WHERE i.oh_id = %s"
)
