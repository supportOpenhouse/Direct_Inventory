"""Inventory endpoints: list, get, create, update (incl. stage/notes/assignment).

Visibility:
  - admin     : sees everything
  - manager   : sees rows in their cities
  - rm        : strict narrowest-wins —
                  users.society set    → ONLY those societies (no city, no
                                          assignment overlay),
                  else users.micro_market set
                                       → look up societies via
                                          PROPERTIES_DB.master_societies
                                          (society_name where micro_market =
                                          ANY user's micros); ONLY those
                                          societies. Empty lookup → nothing.
                  else (both empty)    → assigned_rm_id = me OR city ∈ cities.
"""
from __future__ import annotations

from flask import Blueprint, g, jsonify, request

import logging

from ..db import get_conn, get_props_conn
from ..services.activity import log as log_activity

log = logging.getLogger(__name__)
from ..services.assignment import resolve_assignment
from ..services.cp_match import MATCH_INPUT_FIELDS, annotate_cp_match, backfill_one_chunk
from ..services.oh_id import next_oh_id
from .auth import require_auth

bp = Blueprint("inventory", __name__, url_prefix="/api/inventory")

VALID_STAGES = {
    # Active stages shown on the board.
    "qualified",
    "call_not_received",     # split from the old follow_up_cnr
    "follow_up",             # new — ongoing conversation
    "visit_scheduled",
    "rejected",
    # Legacy stages — no longer shown on the kanban, but still accepted so the
    # Forms webhook (visit completed/cancelled/rescheduled flow) keeps working
    # and historical rows in these stages can be moved out manually if needed.
    "visit_completed",
    "offer_given",
    "unreachable",
}

# Whitelist of fields the client can sort by. Maps the API name → SQL fragment.
# Variation is computed (asking - oh_price) / oh_price; everything else is a column.
SORTABLE_FIELDS = {
    "oh_id":         "oh_id",
    "city":          "city",
    "society":       "society",
    "bedrooms":      "bedrooms",
    "floor":         "floor",
    "area_sqft":     "area_sqft",
    "price":         "price",
    "oh_price":      "oh_price",
    "variation":     "CASE WHEN oh_price IS NULL OR oh_price = 0 THEN NULL "
                     "ELSE (price::FLOAT - oh_price) / oh_price * 100 END",
    # Stage sorts in pipeline order, not alphabetically.
    "stage":         "CASE stage WHEN 'qualified' THEN 0 WHEN 'call_not_received' THEN 1 "
                     "WHEN 'follow_up' THEN 2 WHEN 'visit_scheduled' THEN 3 "
                     "WHEN 'rejected' THEN 4 ELSE 5 END",
    "seller_name":   "seller_name",
    "seller_phone":  "seller_phone",
    "posting_date":  "posting_date",
    "created_at":    "created_at",
    "follow_up_at":  "follow_up_at",
    "notes":         "notes",
    "updated_at":    "updated_at",
}

VALID_REJECT_REASONS = {
    "not_interested",
    "invalid_duplicate",
    "future_prospect",
    "oh_rejected",
    "sold",
    "broker_listing",
}

EDITABLE_RAW_FIELDS = {
    "source", "city", "locality", "society", "bedrooms", "area_sqft",
    "floor", "tower", "unit_no",
    "price", "seller_name", "seller_phone", "posting_date", "listing_link",
}

# Fields that bulk-update may set. Single-row PATCH allows more (notes, raw fields).
BULK_ALLOWED_FIELDS = {
    "stage", "reject_reason", "assigned_rm_id", "assigned_mgr_id", "follow_up_at",
    "priority",
}

# Roles allowed to flag a lead as Priority / set star_color.
PRIORITY_ROLES = {"admin", "manager", "rm"}


def _expand_cities(cities: list[str]) -> list[str]:
    """Match the city-tab convention used at [_build_filters/`if city == "Noida"`]
    and at the counts endpoint: the logical city 'Noida' includes 'Greater Noida'
    in the DB. Without this, an RM/manager scoped to 'Noida' would silently miss
    every 'Greater Noida' row even though the Noida tab shows them.
    """
    expanded = set(cities)
    if "Noida" in expanded:
        expanded.add("Greater Noida")
    return list(expanded)


def _rm_society_scope(user: dict) -> list[str] | None:
    """Resolve the RM's micro_market list to a list of society names via
    PROPERTIES_DB.master_societies. Only invoked when users.society is empty
    AND users.micro_market is non-empty (callers handle the other branches).

    Returns:
      list[str] — societies found (possibly empty if the lookup hit no rows).
      None      — lookup couldn't run (DB unreachable / schema mismatch).
                  Caller treats this the same as "empty" under strict scoping.

    Cached per-request on flask.g so list+counts+notifications in the same
    request don't duplicate the master_societies query.
    """
    cache_key = "_rm_society_scope"
    if hasattr(g, cache_key):
        return getattr(g, cache_key)

    micros = user.get("micro_market") or []
    result: list[str] | None = None
    if micros:
        try:
            conn = get_props_conn()
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT DISTINCT society_name FROM master_societies "
                        "WHERE micro_market = ANY(%s)",
                        (micros,),
                    )
                    rows = cur.fetchall()
                    result = [r["society_name"] for r in rows]
            finally:
                conn.close()
        except Exception:
            log.exception(
                "master_societies lookup failed for user_id=%s", user.get("id")
            )
            result = None

    setattr(g, cache_key, result)
    return result


def _scope_clause(user: dict, alias: str = "") -> tuple[str, list]:
    """Return (sql_where_fragment, params) for visibility filtering.

    Roles:
      admin    — sees everything.
      manager  — sees rows in their assigned cities (empty cities → nothing).
      rm       — strict narrowest-wins, in this order:
                 1) users.society non-empty → ONLY rows where society is in
                    that list. No city / assignment overlay.
                 2) else users.micro_market non-empty → resolve to societies
                    via PROPERTIES_DB.master_societies; ONLY rows in those
                    societies. Empty resolution → nothing visible.
                 3) else (both NULL/empty) → rows assigned to them OR rows
                    in their cities (the prior default behavior).

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

    # rm — strict society overlay if configured, else city/assignment fallback.
    # Society matching is case/whitespace-insensitive: the data has casing
    # drift (e.g. 'ROF' / 'Rof' / 'rof'), so both sides go through
    # LOWER(TRIM()).
    societies = user.get("society") or []
    if societies:
        return (
            f"AND LOWER(TRIM({p}society)) = ANY(%s)",
            [[s.strip().lower() for s in societies]],
        )

    micros = user.get("micro_market") or []
    if micros:
        resolved = _rm_society_scope(user)  # cached master_societies lookup
        if resolved:
            return (
                f"AND LOWER(TRIM({p}society)) = ANY(%s)",
                [[s.strip().lower() for s in resolved]],
            )
        # Micromarket set but the master_societies lookup returned nothing
        # (or failed). Strict scoping → no rows visible.
        return ("AND FALSE", [])

    # Neither society nor micro_market → fall back to city + assignment.
    cities = user.get("cities") or []
    if cities:
        return (
            f"AND ({p}assigned_rm_id = %s OR {p}city = ANY(%s))",
            [user["id"], _expand_cities(cities)],
        )
    return (f"AND {p}assigned_rm_id = %s", [user["id"]])


def _rm_filter_clause(conn, rm_id: str, alias: str = "") -> tuple[str, list]:
    """WHERE fragment for the board's RM filter.

    There is no real per-row RM assignment — `assigned_rm_id` is unused. An RM
    "has" a property iff the visibility rules (see _scope_clause) would surface
    it: users.society, else users.micro_market (resolved to societies via
    PROPERTIES_DB.master_societies), else users.cities.

    rm_id:
      '<int>' — rows the visibility rules give to that one RM.
      'none'  — rows no active RM can see at all.

    All active RMs collapse once into two sets — covered societies and covered
    cities — so the per-row test is a single ANY() check. No per-RM or per-row
    work, and at most two small lookups (users, then master_societies).
    """
    p = f"{alias}." if alias else ""
    with conn.cursor() as cur:
        if rm_id == "none":
            cur.execute(
                "SELECT society, micro_market, cities FROM users "
                "WHERE role = 'rm' AND is_active = TRUE"
            )
        else:
            cur.execute(
                "SELECT society, micro_market, cities FROM users "
                "WHERE role = 'rm' AND is_active = TRUE AND id = %s",
                (int(rm_id),),
            )
        rms = cur.fetchall()

    cover_societies: set = set()
    cover_cities: set = set()
    micros_to_resolve: set = set()
    for rm in rms:
        soc = rm.get("society") or []
        mic = rm.get("micro_market") or []
        cit = rm.get("cities") or []
        # Narrowest-wins, mirroring _scope_clause: society > micro_market > city.
        if soc:
            cover_societies.update(soc)
        elif mic:
            micros_to_resolve.update(mic)
        elif cit:
            cover_cities.update(_expand_cities(cit))

    if micros_to_resolve:
        try:
            pconn = get_props_conn()
            try:
                with pconn.cursor() as pcur:
                    pcur.execute(
                        "SELECT DISTINCT society_name FROM master_societies "
                        "WHERE micro_market = ANY(%s) AND society_name IS NOT NULL",
                        (list(micros_to_resolve),),
                    )
                    cover_societies.update(r["society_name"] for r in pcur.fetchall())
            finally:
                pconn.close()
        except Exception:
            log.exception("master_societies lookup failed for RM filter")

    parts: list[str] = []
    params: list = []
    if cover_societies:
        # Case/whitespace-insensitive — society casing drifts in the data.
        parts.append(f"COALESCE(LOWER(TRIM({p}society)) = ANY(%s), FALSE)")
        params.append([s.strip().lower() for s in cover_societies])
    if cover_cities:
        parts.append(f"{p}city = ANY(%s)")
        params.append(list(cover_cities))
    covered = "(" + " OR ".join(parts) + ")" if parts else "FALSE"

    if rm_id == "none":
        return (f"AND NOT {covered}", params)
    return (f"AND {covered}", params)


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
    if q:
        # Substring ("half") search: each whitespace-separated token must
        # appear case-insensitively, anywhere, in at least one searchable
        # column. Mirrors the old full-text AND-of-words behaviour but also
        # matches partial words — e.g. "par" finds "Park". LIKE wildcards
        # (% _ \) in the token are escaped so they match literally.
        search_cols = [
            "oh_id", "society", "seller_name", "locality",
            "city", "source", "notes", "listing_link",
        ]
        for tok in q.split():
            esc = tok.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            like = f"%{esc}%"
            ored = " OR ".join(f"{p}{c} ILIKE %s" for c in search_cols)
            base_filters.append(f"AND ({ored})")
            base_params.extend([like] * len(search_cols))
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
        try:
            bhks = [int(x) for x in bhk_csv.split(",") if x.strip()]
            if bhks:
                base_filters.append(f"AND {p}bedrooms = ANY(%s)")
                base_params.append(bhks)
        except ValueError:
            pass
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
    follow_up_from = (args.get("follow_up_from") or "").strip()
    follow_up_to   = (args.get("follow_up_to") or "").strip()
    if follow_up_from:
        base_filters.append(f"AND {p}follow_up_at >= %s")
        base_params.append(follow_up_from)
    if follow_up_to:
        base_filters.append(f"AND {p}follow_up_at <= %s")
        base_params.append(follow_up_to)
    if source:
        base_filters.append(f"AND {p}source = %s")
        base_params.append(source)

    priority_raw = args.get("priority")
    if priority_raw not in (None, ""):
        # Accept 1/0, true/false, yes/no. Default to TRUE when the param is just `?priority`.
        truthy = str(priority_raw).strip().lower() in ("1", "true", "yes", "")
        if truthy:
            base_filters.append(f"AND {p}priority = TRUE")

    # Star filter (admin-only in the UI). Comma-separated list of effective
    # star categories. The CASE mirrors the frontend starColor() resolution:
    # explicit star_color override wins, then priority, then cp_match.
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

    return scope, scope_params, base_filters, base_params, post_filters, post_params


# Common subquery: inventory + best-matching OH Pricing row, with match_kind.
# We always wrap this in an outer SELECT so variation filters (which reference
# oh_price) can be applied uniformly across list / counts / count_total.
_INVENTORY_WITH_PRICING_SQL = """
    SELECT i.*,
           p.acq_price    AS oh_price,
           p.area_sqft    AS oh_price_area,
           p.bhk          AS oh_price_bhk,
           p.match_kind   AS oh_price_match
    FROM inventory i
    LEFT JOIN LATERAL (
        SELECT op.acq_price, op.area_sqft, op.bhk,
               CASE
                 WHEN i.area_sqft IS NULL OR op.area_sqft IS NULL THEN 'no_area'
                 WHEN ABS(op.area_sqft - i.area_sqft) <= 150       THEN 'exact'
                 ELSE 'nearest'
               END AS match_kind
        FROM oh_pricing op
        WHERE op.society_norm = LOWER(TRIM(i.society))
          AND op.acq_price IS NOT NULL
          AND (op.bhk IS NULL OR i.bedrooms IS NULL OR op.bhk = i.bedrooms)
        ORDER BY
          (CASE WHEN op.bhk = i.bedrooms THEN 0 ELSE 1 END),
          (CASE WHEN op.area_sqft IS NULL OR i.area_sqft IS NULL
                THEN 9999
                ELSE ABS(op.area_sqft - i.area_sqft) END)
        LIMIT 1
    ) p ON TRUE
"""


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
        # RM filter — visibility-based (assigned_rm_id is unused; an RM "has" a
        # property only via the _scope_clause rules). Needs a DB lookup, so it
        # is resolved here rather than inside the pure _build_filters.
        rm_id = (args.get("rm_id") or "").strip()
        if rm_id == "none" or rm_id.isdigit():
            rm_sql, rm_params = _rm_filter_clause(conn, rm_id, alias="i")
            base_filters.append(rm_sql)
            base_params.extend(rm_params)

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
        # date clashes. 'smart' has no priority float / rejected sink. An
        # explicit column-header sort is a pure column sort — no rejected sink,
        # no priority float — with updated_at DESC only as the final tiebreaker.
        sort_field = (args.get("sort") or "smart").strip()
        if sort_field == "smart":
            today_ist = "(NOW() AT TIME ZONE 'Asia/Kolkata')::DATE"
            order_clause = (
                f"CASE WHEN follow_up_at IS NULL THEN 3 "
                f"     WHEN follow_up_at::DATE = {today_ist} THEN 0 "
                f"     WHEN follow_up_at::DATE < {today_ist} THEN 1 "
                f"     ELSE 2 END ASC, "
                # Stage order applies only inside the overdue bucket.
                f"CASE WHEN follow_up_at IS NOT NULL AND follow_up_at::DATE < {today_ist} "
                f"     THEN CASE stage WHEN 'follow_up' THEN 0 WHEN 'qualified' THEN 1 ELSE 2 END "
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

        list_sql = f"""
            SELECT * FROM ({_INVENTORY_WITH_PRICING_SQL} {inner_where}) j
            {outer_where}
            ORDER BY {order_clause}
            LIMIT %s OFFSET %s
        """
        count_sql = f"""
            SELECT COUNT(*) AS n FROM ({_INVENTORY_WITH_PRICING_SQL} {inner_where}) j
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
        return jsonify({"items": rows, "total": total, "limit": limit, "offset": offset})
    finally:
        conn.close()


@bp.get("/societies")
@require_auth()
def list_societies():
    """Society + locality master list for a given city.

    Used to populate the Add Inventory modal's Society dropdown.
    Pulls from the read-only properties.master_societies table.
    The logical city 'Noida' includes 'Greater Noida'.
    """
    city = (request.args.get("city") or "").strip()
    if not city:
        return jsonify({"items": []})

    cities = ["Noida", "Greater Noida"] if city == "Noida" else [city]

    from ..db import get_props_conn
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
    # request.args is multidict; wrapping in a dict is OK since we read each key once.
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

    # Board-visible stages only. Counts for legacy stages are intentionally
    # omitted from the response (the chips for them no longer exist).
    all_stages = [
        "qualified", "call_not_received", "follow_up", "visit_scheduled", "rejected",
    ]

    conn = get_conn()
    try:
        # RM filter — visibility-based (assigned_rm_id is unused); see
        # _rm_filter_clause. Needs a DB lookup, hence resolved here.
        rm_id = (request.args.get("rm_id") or "").strip()
        if rm_id == "none" or rm_id.isdigit():
            rm_sql, rm_params = _rm_filter_clause(conn, rm_id, alias="i")
            base_filters.append(rm_sql)
            base_params.extend(rm_params)

        inner_where = f"WHERE TRUE {scope} {' '.join(base_filters)}"
        outer_where = f"WHERE TRUE {' '.join(post_filters)}"

        with conn, conn.cursor() as cur:
            cur.execute(
                f"""SELECT stage, COUNT(*) AS n FROM (
                       {_INVENTORY_WITH_PRICING_SQL} {inner_where}
                   ) j {outer_where}
                   GROUP BY stage""",
                [*scope_params, *base_params, *post_params],
            )
            by_stage = {s: 0 for s in all_stages}
            for r in cur.fetchall():
                by_stage[r["stage"]] = r["n"]
            cur.execute(
                f"""SELECT COUNT(*) AS n FROM (
                       {_INVENTORY_WITH_PRICING_SQL} {inner_where}
                   ) j {outer_where}""",
                [*scope_params, *base_params, *post_params],
            )
            total = cur.fetchone()["n"]
        return jsonify({"total": total, "by_stage": by_stage})
    finally:
        conn.close()


@bp.post("/cp-match-scan")
@require_auth("admin", "manager", "rm")
def cp_match_scan():
    """Chunked scan: process ONE batch starting after `cursor` (oh_id).

    Frontend loops, passing back `next_cursor` from the previous response and
    accumulating totals in `prior_totals`, until the response has `done: true`.
    Keeps each request short enough to survive any proxy/gateway timeout
    regardless of total table size. Admin-only.

    Request:  { cursor?: string, prior_totals?: {perfect, partial, no_match} }
    Response: { done, next_cursor, perfect, partial, no_match, processed }
    """
    body = request.get_json(silent=True) or {}
    cursor = body.get("cursor") or ""
    prior = body.get("prior_totals") or {}

    conn = get_conn()
    try:
        chunk = backfill_one_chunk(conn, cursor)
        if chunk["done"]:
            cumulative = {
                "perfect": int(prior.get("perfect") or 0) + chunk["perfect"],
                "partial": int(prior.get("partial") or 0) + chunk["partial"],
                "no_match": int(prior.get("no_match") or 0) + chunk["no_match"],
            }
            cumulative["total"] = cumulative["perfect"] + cumulative["partial"] + cumulative["no_match"]
            with conn, conn.cursor() as cur:
                log_activity(
                    cur,
                    actor_user_id=g.user["id"],
                    actor_email=g.user["email"],
                    entity_type="cp_match_scan",
                    entity_id=None,
                    action="run",
                    metadata=cumulative,
                )
        return jsonify(chunk)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        log.exception("cp_match scan failed (cursor=%r)", cursor)
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500
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


@bp.get("/<oh_id>")
@require_auth()
def get_one(oh_id: str):
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT * FROM inventory WHERE oh_id = %s", (oh_id,))
            row = cur.fetchone()
            if not row:
                return jsonify({"error": "not found"}), 404
            # Pull recent activity for this entity
            cur.execute(
                """
                SELECT id, actor_email, action, field, before_value, after_value, metadata, created_at
                FROM activity_log
                WHERE entity_type = 'inventory' AND entity_id = %s
                ORDER BY created_at DESC LIMIT 100
                """,
                (oh_id,),
            )
            row["activity"] = cur.fetchall()
        return jsonify(row)
    finally:
        conn.close()


@bp.get("/<oh_id>/visible-rms")
@require_auth("admin", "manager")
def visible_rms(oh_id: str):
    """Which RMs would see this property under the visibility rules.

    Inverts the per-RM logic in _scope_clause: for each active RM, apply
    their scope (society > micro_market > city/assignment) to this one row.
    Admin/manager only.

    Response: { oh_id, rms: [{ id, name, email, via }] }
      via ∈ {'society','micro_market','city','assignment'}
    """
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT oh_id, society, city, assigned_rm_id FROM inventory WHERE oh_id = %s",
                (oh_id,),
            )
            inv = cur.fetchone()
            if not inv:
                return jsonify({"error": "not found"}), 404
            cur.execute(
                "SELECT id, name, email, society, micro_market, cities "
                "FROM users WHERE role = 'rm' AND is_active = TRUE"
            )
            rms = cur.fetchall()
    finally:
        conn.close()

    society = inv.get("society")
    # Society casing drifts in the data ('ROF' / 'Rof' / 'rof') — normalise.
    society_norm = (society or "").strip().lower()
    city = inv.get("city")
    assigned_rm_id = inv.get("assigned_rm_id")

    # Micro-markets that contain this property's society — an RM scoped by
    # micro_market sees the row iff their micros intersect this set. This is
    # the inverse of _rm_society_scope's micro_market -> societies resolution.
    prop_micros: set = set()
    if society:
        try:
            pconn = get_props_conn()
            try:
                with pconn.cursor() as pcur:
                    pcur.execute(
                        "SELECT DISTINCT micro_market FROM master_societies "
                        "WHERE LOWER(TRIM(society_name)) = LOWER(TRIM(%s)) "
                        "  AND micro_market IS NOT NULL",
                        (society,),
                    )
                    prop_micros = {r["micro_market"] for r in pcur.fetchall()}
            finally:
                pconn.close()
        except Exception:
            log.exception("master_societies lookup failed for visible-rms oh_id=%s", oh_id)

    matched = []
    for rm in rms:
        rm_soc = rm.get("society") or []
        rm_micro = rm.get("micro_market") or []
        rm_cities = rm.get("cities") or []
        via = None
        if rm_soc:
            if society_norm and society_norm in {s.strip().lower() for s in rm_soc}:
                via = "society"
        elif rm_micro:
            if prop_micros and set(rm_micro) & prop_micros:
                via = "micro_market"
        elif rm_cities:
            if assigned_rm_id == rm["id"]:
                via = "assignment"
            elif city and city in _expand_cities(rm_cities):
                via = "city"
        elif assigned_rm_id == rm["id"]:
            via = "assignment"
        if via:
            matched.append({
                "id": rm["id"], "name": rm["name"], "email": rm["email"], "via": via,
            })

    matched.sort(key=lambda r: (r["name"] or r["email"] or "").lower())
    return jsonify({"oh_id": oh_id, "rms": matched})


@bp.post("")
@require_auth("admin", "manager", "rm")
def create_one():
    user = g.user
    body = request.get_json(silent=True) or {}
    # listing_link is no longer required for manual entries — auto-generate if missing.
    required = ["city", "society"]
    for k in required:
        if not body.get(k):
            return jsonify({"error": f"missing field: {k}"}), 400

    fields = {k: body.get(k) for k in EDITABLE_RAW_FIELDS}
    if not fields.get("source"):
        fields["source"] = "Website"

    if not (fields.get("listing_link") or "").strip():
        import uuid as _uuid
        fields["listing_link"] = f"internal://manual/{_uuid.uuid4()}"

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            # dedup on listing_link (auto-generated UUIDs are unique by construction;
            # this still catches user-provided duplicates).
            cur.execute("SELECT oh_id FROM inventory WHERE listing_link = %s", (fields["listing_link"],))
            existing = cur.fetchone()
            if existing:
                return jsonify({"error": "listing already exists", "oh_id": existing["oh_id"]}), 409

            oh_id = next_oh_id(cur, fields["city"])
            rm_id, mgr_id = resolve_assignment(
                cur, city=fields["city"], locality=fields.get("locality"), society=fields.get("society"),
            )

            cur.execute(
                """
                INSERT INTO inventory (
                    oh_id, source, city, locality, society, bedrooms, area_sqft,
                    floor, tower, unit_no,
                    price, seller_name, seller_phone, posting_date, listing_link,
                    stage, assigned_rm_id, assigned_mgr_id, follow_up_at, last_synced_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s,
                          %s, %s, %s,
                          %s, %s, %s, %s, %s,
                          'qualified', %s, %s,
                          (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE, NULL)
                RETURNING *
                """,
                (
                    oh_id, fields["source"], fields["city"], fields.get("locality"),
                    fields.get("society"), fields.get("bedrooms"), fields.get("area_sqft"),
                    fields.get("floor"), fields.get("tower"), fields.get("unit_no"),
                    fields.get("price"), fields.get("seller_name"),
                    fields.get("seller_phone"), fields.get("posting_date"), fields["listing_link"],
                    rm_id, mgr_id,
                ),
            )
            row = cur.fetchone()

            log_activity(
                cur,
                actor_user_id=user["id"],
                actor_email=user["email"],
                entity_type="inventory",
                entity_id=oh_id,
                action="create",
                metadata={"source": fields["source"], "auto_assigned_rm": rm_id, "auto_assigned_mgr": mgr_id},
            )
        return jsonify(row), 201
    finally:
        conn.close()


@bp.patch("/<oh_id>")
@require_auth("admin", "manager", "rm")
def update_one(oh_id: str):
    """Patch any subset of fields. Each changed field gets its own activity row."""
    user = g.user
    body = request.get_json(silent=True) or {}

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT * FROM inventory WHERE oh_id = %s FOR UPDATE", (oh_id,))
            existing = cur.fetchone()
            if not existing:
                return jsonify({"error": "not found"}), 404

            # Any authenticated admin/manager/rm can edit any field they have UI
            # access to. Cross-assignment edits are intentionally allowed; the
            # per-field activity_log row (with actor_email + role) is the audit
            # trail. Priority is the one exception — still admin/manager only,
            # enforced below.
            cross_assignment_edit = (
                user["role"] == "rm" and existing["assigned_rm_id"] != user["id"]
            ) or (
                user["role"] == "manager"
                and existing["city"] not in _expand_cities(user.get("cities") or [])
            )

            updates = []
            params: list = []
            requires_visit_form = False
            invalidate_cp_match = False

            allowed = EDITABLE_RAW_FIELDS | {
                "stage", "reject_reason", "notes", "assigned_rm_id", "assigned_mgr_id",
                "follow_up_at", "priority", "star_color", "cp_match",
            }
            for k, v in body.items():
                if k not in allowed:
                    continue
                if existing.get(k) == v:
                    continue
                if k == "priority" and user["role"] not in PRIORITY_ROLES:
                    return jsonify({"error": "only admin/manager can change priority"}), 403
                if k == "priority":
                    v = bool(v)
                if k == "star_color":
                    if user["role"] not in PRIORITY_ROLES:
                        return jsonify({"error": "only admin/manager can change star_color"}), 403
                    if v in ("", None):
                        v = None
                    elif v not in ("red", "green", "yellow", "none"):
                        return jsonify({"error": f"invalid star_color: {v}"}), 400
                if k == "cp_match":
                    # Manual override that mirrors the auto-scan verdict. Same role
                    # gate as star_color since they're set together from the picker.
                    if user["role"] not in PRIORITY_ROLES:
                        return jsonify({"error": "only admin/manager can change cp_match"}), 403
                    if v in ("", None):
                        v = None
                    elif v not in ("perfect", "partial", "none"):
                        return jsonify({"error": f"invalid cp_match: {v}"}), 400
                if k == "stage":
                    if v not in VALID_STAGES:
                        return jsonify({"error": f"invalid stage: {v}"}), 400
                    if v == "rejected" and not body.get("reject_reason") and not existing.get("reject_reason"):
                        return jsonify({"error": "reject_reason required when stage=rejected"}), 400
                    if v == "visit_scheduled":
                        requires_visit_form = True
                if k == "reject_reason" and v and v not in VALID_REJECT_REASONS:
                    return jsonify({"error": f"invalid reject_reason: {v}"}), 400
                if k in MATCH_INPUT_FIELDS:
                    invalidate_cp_match = True
                updates.append(f"{k} = %s")
                params.append(v)
                log_activity(
                    cur,
                    actor_user_id=user["id"],
                    actor_email=user["email"],
                    entity_type="inventory",
                    entity_id=oh_id,
                    action=("stage_change" if k == "stage" else "update"),
                    field=k,
                    before_value=existing.get(k),
                    after_value=v,
                    metadata={
                        "actor_role": user["role"],
                        "cross_assignment": cross_assignment_edit,
                    },
                )

            if not updates:
                return jsonify({"oh_id": oh_id, "noop": True})

            # If any match-determining field changed, drop the persisted verdict so
            # the next scan reclassifies. Cheap NULL is better than a stale label.
            if invalidate_cp_match:
                updates.append("cp_match = NULL")

            params.append(oh_id)
            cur.execute(
                f"UPDATE inventory SET {', '.join(updates)} WHERE oh_id = %s RETURNING *",
                params,
            )
            row = cur.fetchone()
        return jsonify({"item": row, "requires_visit_form": requires_visit_form})
    finally:
        conn.close()


@bp.post("/bulk-update")
@require_auth("admin", "manager", "rm")
def bulk_update():
    """Update the same field(s) on many inventory rows in one call.

    Body: { oh_ids: [...], updates: { stage?, reject_reason?, assigned_rm_id?,
            assigned_mgr_id?, follow_up_at? } }

    Returns: { updated, skipped_forbidden: [oh_id...], not_found: [oh_id...] }

    Visibility rules apply (rm: own rows only; manager: own cities only).
    `stage=visit_scheduled` is rejected — that needs the per-row visit modal.
    """
    user = g.user
    body = request.get_json(silent=True) or {}
    oh_ids = body.get("oh_ids") or []
    updates = body.get("updates") or {}

    if not isinstance(oh_ids, list) or not oh_ids:
        return jsonify({"error": "oh_ids must be a non-empty array"}), 400
    if not isinstance(updates, dict) or not updates:
        return jsonify({"error": "updates must be a non-empty object"}), 400

    bad = [k for k in updates if k not in BULK_ALLOWED_FIELDS]
    if bad:
        return jsonify({"error": f"fields not allowed in bulk update: {bad}"}), 400

    if "priority" in updates:
        if user["role"] not in PRIORITY_ROLES:
            return jsonify({"error": "only admin/manager can change priority"}), 403
        updates["priority"] = bool(updates["priority"])

    stage = updates.get("stage")
    if stage is not None and stage not in VALID_STAGES:
        return jsonify({"error": f"invalid stage: {stage}"}), 400
    if stage == "visit_scheduled":
        return jsonify({"error": "visit_scheduled requires the per-row schedule modal"}), 400
    if stage == "rejected" and not updates.get("reject_reason"):
        return jsonify({"error": "reject_reason required when stage=rejected"}), 400
    reject_reason = updates.get("reject_reason")
    if reject_reason and reject_reason not in VALID_REJECT_REASONS:
        return jsonify({"error": f"invalid reject_reason: {reject_reason}"}), 400

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT oh_id, city, stage, assigned_rm_id, follow_up_at, reject_reason, "
                "assigned_mgr_id, priority "
                "FROM inventory WHERE oh_id = ANY(%s) FOR UPDATE",
                (oh_ids,),
            )
            existing = {r["oh_id"]: r for r in cur.fetchall()}

            not_found = [oid for oid in oh_ids if oid not in existing]
            forbidden: list[str] = []
            allowed_ids: list[str] = []
            for oid, row in existing.items():
                if user["role"] == "rm" and row["assigned_rm_id"] != user["id"]:
                    forbidden.append(oid); continue
                if user["role"] == "manager" and row["city"] not in _expand_cities(user.get("cities") or []):
                    forbidden.append(oid); continue
                allowed_ids.append(oid)

            updated_count = 0
            if allowed_ids:
                set_parts = []
                params: list = []
                for k, v in updates.items():
                    set_parts.append(f"{k} = %s")
                    params.append(v)
                params.append(allowed_ids)
                cur.execute(
                    f"UPDATE inventory SET {', '.join(set_parts)} WHERE oh_id = ANY(%s)",
                    params,
                )
                updated_count = cur.rowcount

                # One activity_log row per (entity, field changed).
                for oid in allowed_ids:
                    before = existing[oid]
                    for k, v in updates.items():
                        if before.get(k) == v:
                            continue
                        log_activity(
                            cur,
                            actor_user_id=user["id"], actor_email=user["email"],
                            entity_type="inventory", entity_id=oid,
                            action=("bulk_stage_change" if k == "stage" else "bulk_update"),
                            field=k, before_value=before.get(k), after_value=v,
                            metadata={"bulk_batch_size": len(allowed_ids)},
                        )

        return jsonify({
            "requested": len(oh_ids),
            "updated": updated_count,
            "skipped_forbidden": forbidden,
            "not_found": not_found,
        })
    finally:
        conn.close()
