"""Google OAuth login + JWT issuance.

Login flow:
  1. Frontend uses Google Identity Services to obtain an `id_token` JWT.
  2. Frontend POSTs `{ id_token }` to /api/auth/google.
  3. Backend verifies the token, enforces openhouse.in domain, looks up the
     user row by email, and issues an app JWT.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import wraps

import jwt
from flask import Blueprint, g, jsonify, request
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from .. import config
from ..db import get_conn
from ..services.activity import log as log_activity

bp = Blueprint("auth", __name__, url_prefix="/api/auth")


def _issue_jwt(user_row: dict) -> str:
    payload = {
        "sub": user_row["id"],
        "email": user_row["email"],
        "name": user_row.get("name"),
        "role": user_row["role"],
        "cities": user_row["cities"] or [],
        # Optional finer-grained RM scoping (see inventory._scope_clause).
        "society": user_row.get("society") or [],
        "micro_market": user_row.get("micro_market") or [],
        "exp": datetime.now(tz=timezone.utc) + timedelta(hours=config.JWT_EXPIRY_HOURS),
    }
    return jwt.encode(payload, config.JWT_SECRET, algorithm=config.JWT_ALGORITHM)


def _public_user(user: dict) -> dict:
    return {
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "role": user["role"],
        "cities": user["cities"] or [],
    }


@bp.post("/google")
def google_login():
    body = request.get_json(silent=True) or {}
    token = body.get("id_token")
    if not token:
        return jsonify({"error": "missing id_token"}), 400
    if not config.GOOGLE_OAUTH_CLIENT_ID:
        return jsonify({"error": "server not configured for Google OAuth"}), 500

    try:
        info = id_token.verify_oauth2_token(
            token, google_requests.Request(), config.GOOGLE_OAUTH_CLIENT_ID
        )
    except ValueError as e:
        return jsonify({"error": f"invalid id_token: {e}"}), 401

    email = (info.get("email") or "").lower()
    if not email or not info.get("email_verified"):
        return jsonify({"error": "email not verified"}), 401
    if not email.endswith("@" + config.ALLOWED_EMAIL_DOMAIN):
        return jsonify({"error": f"only @{config.ALLOWED_EMAIL_DOMAIN} accounts allowed"}), 403

    name = info.get("name") or email.split("@")[0]

    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT id, email, name, role, cities, society, micro_market, is_active FROM users WHERE email = %s",
                (email,),
            )
            user = cur.fetchone()
            if not user:
                # Auto-provision unknown users as 'rm' with no city — admin must activate.
                cur.execute(
                    """
                    INSERT INTO users (email, name, role, cities, is_active)
                    VALUES (%s, %s, 'rm', '{}', FALSE)
                    RETURNING id, email, name, role, cities, society, micro_market, is_active
                    """,
                    (email, name),
                )
                user = cur.fetchone()
                log_activity(
                    cur,
                    actor_user_id=user["id"],
                    actor_email=email,
                    entity_type="user",
                    entity_id=str(user["id"]),
                    action="auto_provision",
                    metadata={"name": name},
                )
                return jsonify({
                    "error": "account pending activation by admin",
                    "email": email,
                }), 403

            if not user["is_active"]:
                return jsonify({"error": "account disabled"}), 403

            log_activity(
                cur,
                actor_user_id=user["id"],
                actor_email=email,
                entity_type="auth",
                entity_id=str(user["id"]),
                action="login",
                metadata={"ip": request.remote_addr, "ua": request.headers.get("User-Agent")},
            )

            token_str = _issue_jwt(user)
            return jsonify({"token": token_str, "user": _public_user(user)})
    finally:
        conn.close()


def require_auth(*allowed_roles: str):
    """Decorator: require a valid JWT and (optionally) one of allowed_roles.

    On success, sets `g.user = {id, email, role, cities, ...}`.
    """
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            auth = request.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                return jsonify({"error": "missing bearer token"}), 401
            token = auth[len("Bearer "):]
            try:
                payload = jwt.decode(token, config.JWT_SECRET, algorithms=[config.JWT_ALGORITHM])
            except jwt.ExpiredSignatureError:
                return jsonify({"error": "token expired"}), 401
            except jwt.InvalidTokenError:
                return jsonify({"error": "invalid token"}), 401

            g.user = {
                "id": payload["sub"],
                "email": payload["email"],
                "name": payload.get("name"),
                "role": payload["role"],
                "cities": payload.get("cities", []),
                "society": payload.get("society", []),
                "micro_market": payload.get("micro_market", []),
            }
            if allowed_roles and g.user["role"] not in allowed_roles:
                return jsonify({"error": "forbidden"}), 403
            return fn(*args, **kwargs)
        return wrapper
    return deco


@bp.get("/me")
@require_auth()
def me():
    return jsonify({"user": g.user})
