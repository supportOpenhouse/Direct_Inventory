"""Post-token / acquisition pipeline endpoints.

NOTE: The Pipeline page (property/acquisition tracker, sourced from
PROPERTIES_DB_URL) is NOT wired to the backend yet — only the visit-scheduled
flow goes through the API (see api/visits.py). The frontend Pipeline page reads
its deal data from a local mock dataset for now.

This blueprint exists so the `/api/post-token/counts` contract has a stable
endpoint; it returns zeroed buckets until the acquisition-DB integration lands.
When that work happens, replace the stub query with a scoped aggregate over the
properties DB acquisition stages.
"""
from __future__ import annotations

from flask import Blueprint, jsonify

from .auth import require_auth

bp = Blueprint("post_token", __name__, url_prefix="/api/post-token")

# Acquisition stages, kept here so the shape is documented in one place.
POST_TOKEN_STAGES = [
    "visit_scheduled", "token_transferred", "docs_received", "review_status",
    "draft_ama", "seller_approval", "ama_signed", "key_handover",
    "rejected", "token_refunded",
]


@bp.get("/counts")
@require_auth()
def counts():
    """Per-stage counts for the acquisition pipeline.

    Stub: returns 0 for every stage until PROPERTIES_DB acquisition data is
    wired in. Shape mirrors the inventory counts endpoint: { by_stage: {...} }.
    """
    return jsonify({"by_stage": {s: 0 for s in POST_TOKEN_STAGES}})
