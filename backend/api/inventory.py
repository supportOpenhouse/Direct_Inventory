"""Inventory endpoints: list, get, create, update (incl. stage/notes/assignment).

Visibility:
  - admin     : sees everything
  - manager   : sees rows in their cities
  - rm        : sees only rows assigned to them
"""
from __future__ import annotations

from flask import Blueprint, g, jsonify, request

from ..db import get_conn
from ..services.activity import log as log_activity
from ..services.assignment import resolve_assignment
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
    "price":         "price",
    "oh_price":      "oh_price",
    "variation":     "CASE WHEN oh_price IS NULL OR oh_price = 0 THEN NULL "
                     "ELSE (price::FLOAT - oh_price) / oh_price * 100 END",
    "posting_date":  "posting_date",
    "follow_up_at":  "follow_up_at",
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
    "floor", "price", "seller_name", "seller_phone", "posting_date", "listing_link",
}

# Fields that bulk-update may set. Single-row PATCH allows more (notes, raw fields).
BULK_ALLOWED_FIELDS = {
    "stage", "reject_reason", "assigned_rm_id", "assigned_mgr_id", "follow_up_at",
    "priority",
}

# Only admin/manager can flag a lead as Priority.
PRIORITY_ROLES = {"admin", "manager"}


def _scope_clause(user: dict, alias: str = "") -> tuple[str, list]:
    """Return (sql_where_fragment, params) for visibility filtering.

    `alias` is the optional table alias prefix (e.g. 'i' if the query uses `inventory i`).
    """
    p = f"{alias}." if alias else ""
    if user["role"] == "admin":
        return ("", [])
    if user["role"] == "manager":
        cities = user.get("cities") or []
        if not cities:
            return ("AND FALSE", [])
        return (f"AND {p}city = ANY(%s)", [cities])
    # rm
    return (f"AND {p}assigned_rm_id = %s", [user["id"]])


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
    rm_id    = args.get("rm_id", type=int)
    q        = (args.get("q") or "").strip()
    society  = (args.get("society") or "").strip()
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
    if rm_id:
        base_filters.append(f"AND {p}assigned_rm_id = %s")
        base_params.append(rm_id)
    if q:
        base_filters.append(f"AND {p}search_tsv @@ plainto_tsquery('simple', %s)")
        base_params.append(q)
    if society:
        base_filters.append(f"AND {p}society ILIKE %s")
        base_params.append(f"%{society}%")
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
    if source:
        base_filters.append(f"AND {p}source = %s")
        base_params.append(source)

    priority_raw = args.get("priority")
    if priority_raw not in (None, ""):
        # Accept 1/0, true/false, yes/no. Default to TRUE when the param is just `?priority`.
        truthy = str(priority_raw).strip().lower() in ("1", "true", "yes", "")
        if truthy:
            base_filters.append(f"AND {p}priority = TRUE")

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

    inner_where = f"WHERE TRUE {scope} {' '.join(base_filters)}"
    outer_where = f"WHERE TRUE {' '.join(post_filters)}"

    # Sort: client picks a column; priority still floats to the top, and we
    # always tie-break on updated_at DESC so pagination is deterministic.
    sort_field = (args.get("sort") or "updated_at").strip()
    sort_dir = "ASC" if (args.get("dir") or "").strip().lower() == "asc" else "DESC"
    sort_sql = SORTABLE_FIELDS.get(sort_field, SORTABLE_FIELDS["updated_at"])
    nulls_clause = "NULLS LAST" if sort_dir == "DESC" else "NULLS FIRST"
    order_clause = (
        "priority DESC, "
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

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(list_sql, final_params)
            rows = cur.fetchall()
            cur.execute(count_sql, count_params)
            total = cur.fetchone()["n"]
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
    inner_where = f"WHERE TRUE {scope} {' '.join(base_filters)}"
    outer_where = f"WHERE TRUE {' '.join(post_filters)}"

    # Board-visible stages only. Counts for legacy stages are intentionally
    # omitted from the response (the chips for them no longer exist).
    all_stages = [
        "qualified", "call_not_received", "follow_up", "visit_scheduled", "rejected",
    ]

    conn = get_conn()
    try:
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
                    floor, price, seller_name, seller_phone, posting_date, listing_link,
                    stage, assigned_rm_id, assigned_mgr_id, last_synced_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                          'qualified', %s, %s, NULL)
                RETURNING *
                """,
                (
                    oh_id, fields["source"], fields["city"], fields.get("locality"),
                    fields.get("society"), fields.get("bedrooms"), fields.get("area_sqft"),
                    fields.get("floor"), fields.get("price"), fields.get("seller_name"),
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

            if user["role"] == "rm" and existing["assigned_rm_id"] != user["id"]:
                return jsonify({"error": "forbidden"}), 403
            if user["role"] == "manager" and existing["city"] not in (user.get("cities") or []):
                return jsonify({"error": "forbidden"}), 403

            updates = []
            params: list = []
            requires_visit_form = False

            allowed = EDITABLE_RAW_FIELDS | {
                "stage", "reject_reason", "notes", "assigned_rm_id", "assigned_mgr_id",
                "follow_up_at", "priority",
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
                if k == "stage":
                    if v not in VALID_STAGES:
                        return jsonify({"error": f"invalid stage: {v}"}), 400
                    if v == "rejected" and not body.get("reject_reason") and not existing.get("reject_reason"):
                        return jsonify({"error": "reject_reason required when stage=rejected"}), 400
                    if v == "visit_scheduled":
                        requires_visit_form = True
                if k == "reject_reason" and v and v not in VALID_REJECT_REASONS:
                    return jsonify({"error": f"invalid reject_reason: {v}"}), 400
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
                )

            if not updates:
                return jsonify({"oh_id": oh_id, "noop": True})

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
                if user["role"] == "manager" and row["city"] not in (user.get("cities") or []):
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
