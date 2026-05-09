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
    "qualified",
    "follow_up_cnr",         # Follow Up — Call Not Received
    "visit_scheduled",
    "visit_completed",
    "offer_given",
    "unreachable",
    "rejected",
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
    "floor", "price", "seller_name", "posting_date", "listing_link",
}


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


@bp.get("")
@require_auth()
def list_inventory():
    user = g.user
    args = request.args
    q       = (args.get("q") or "").strip()
    stage   = args.get("stage")
    city    = args.get("city")
    rm_id   = args.get("rm_id", type=int)
    limit   = min(args.get("limit", 200, type=int), 1000)
    offset  = args.get("offset", 0, type=int)

    # Build scope + filter clauses TWICE — once aliased for the JOINed list query,
    # once unaliased for the COUNT query (which has no JOIN).
    def build_filters(alias: str = ""):
        p = f"{alias}." if alias else ""
        scope, scope_params_local = _scope_clause(user, alias=alias)
        filters = []
        local_params: list = []
        if stage:
            filters.append(f"AND {p}stage = %s")
            local_params.append(stage)
        if city:
            if city == "Noida":
                filters.append(f"AND {p}city IN ('Noida', 'Greater Noida')")
            else:
                filters.append(f"AND {p}city = %s")
                local_params.append(city)
        if rm_id:
            filters.append(f"AND {p}assigned_rm_id = %s")
            local_params.append(rm_id)
        if q:
            filters.append(f"AND {p}search_tsv @@ plainto_tsquery('simple', %s)")
            local_params.append(q)
        return scope, scope_params_local, filters, local_params

    list_scope, list_scope_params, list_filters, list_filter_params = build_filters("i")
    count_scope, count_scope_params, count_filters, count_filter_params = build_filters("")

    # LATERAL join brings the best-matching OH Pricing row alongside each inventory row.
    # Match rule: society MUST match. BHK should match (NULL on either side counted
    # as match). Area is the tiebreaker — closest first. We no longer hard-cap area
    # distance; instead we surface a `match_kind` so the UI can label exact vs nearest.
    # `oh_price` returned to the UI is the Acq Price (★ Acq Price (₹L) on Gurgaon
    # tab; L2 Acq (₹L) on Noida + GZB tab). The sheet's "Selling Price" column is
    # captured in oh_pricing.price but not surfaced to the UI per product decision.
    sql = f"""
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
              AND op.acq_price IS NOT NULL                -- only consider rows with an acq price
              AND (op.bhk IS NULL OR i.bedrooms IS NULL OR op.bhk = i.bedrooms)
            ORDER BY
              (CASE WHEN op.bhk = i.bedrooms THEN 0 ELSE 1 END),
              (CASE WHEN op.area_sqft IS NULL OR i.area_sqft IS NULL
                    THEN 9999
                    ELSE ABS(op.area_sqft - i.area_sqft) END)
            LIMIT 1
        ) p ON TRUE
        WHERE TRUE
          {list_scope}
          {' '.join(list_filters)}
        ORDER BY i.updated_at DESC
        LIMIT %s OFFSET %s
    """
    final_params = [*list_scope_params, *list_filter_params, limit, offset]

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(sql, final_params)
            rows = cur.fetchall()
            cur.execute(
                f"SELECT COUNT(*) AS n FROM inventory WHERE TRUE {count_scope} {' '.join(count_filters)}",
                [*count_scope_params, *count_filter_params],
            )
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
    """Per-stage counts (and grand total) honoring city/q filters and role visibility.

    Used by the Board top-of-page chips so they show real DB-wide counts, not
    just whatever the current page loaded.
    """
    user = g.user
    args = request.args
    q    = (args.get("q") or "").strip()
    city = args.get("city")

    scope_sql, scope_params = _scope_clause(user)

    sql_filters = []
    params: list = []
    if city:
        if city == "Noida":
            sql_filters.append("AND city IN ('Noida', 'Greater Noida')")
        else:
            sql_filters.append("AND city = %s")
            params.append(city)
    if q:
        sql_filters.append("AND search_tsv @@ plainto_tsquery('simple', %s)")
        params.append(q)

    where_extra = " ".join(sql_filters)

    # Always present every stage in the response (zero-fill missing ones) so the
    # frontend doesn't have to fall back when GROUP BY omits a stage with 0 rows.
    all_stages = [
        "qualified", "follow_up_cnr", "visit_scheduled", "visit_completed",
        "offer_given", "unreachable", "rejected",
    ]

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""SELECT stage, COUNT(*) AS n FROM inventory
                    WHERE TRUE {scope_sql} {where_extra}
                    GROUP BY stage""",
                [*scope_params, *params],
            )
            by_stage = {s: 0 for s in all_stages}
            for r in cur.fetchall():
                by_stage[r["stage"]] = r["n"]
            cur.execute(
                f"SELECT COUNT(*) AS n FROM inventory WHERE TRUE {scope_sql} {where_extra}",
                [*scope_params, *params],
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
                    floor, price, seller_name, posting_date, listing_link,
                    stage, assigned_rm_id, assigned_mgr_id, last_synced_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                          'qualified', %s, %s, NULL)
                RETURNING *
                """,
                (
                    oh_id, fields["source"], fields["city"], fields.get("locality"),
                    fields.get("society"), fields.get("bedrooms"), fields.get("area_sqft"),
                    fields.get("floor"), fields.get("price"), fields.get("seller_name"),
                    fields.get("posting_date"), fields["listing_link"],
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
    """Patch any subset of fields. Each changed field gets its own activity row.

    Special handling:
      - stage='visit_scheduled' returns a `requires_visit_form: true` flag so
        the frontend opens the schedule modal. Actual Forms-app POST happens
        when the modal submits to /api/visits/schedule.
      - stage='rejected' requires reject_reason in body.
    """
    user = g.user
    body = request.get_json(silent=True) or {}

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT * FROM inventory WHERE oh_id = %s FOR UPDATE", (oh_id,))
            existing = cur.fetchone()
            if not existing:
                return jsonify({"error": "not found"}), 404

            # Permission: rm can only edit their own rows
            if user["role"] == "rm" and existing["assigned_rm_id"] != user["id"]:
                return jsonify({"error": "forbidden"}), 403
            if user["role"] == "manager" and existing["city"] not in (user.get("cities") or []):
                return jsonify({"error": "forbidden"}), 403

            updates = []
            params: list = []
            requires_visit_form = False

            allowed = EDITABLE_RAW_FIELDS | {"stage", "reject_reason", "notes", "assigned_rm_id", "assigned_mgr_id"}
            for k, v in body.items():
                if k not in allowed:
                    continue
                if existing.get(k) == v:
                    continue
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
