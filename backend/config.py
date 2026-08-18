"""Runtime config loaded from environment variables.

The variables surfaced in `.env.example` are the canonical set for this app:

    ALLOWED_EMAIL_DOMAIN, CP_DB_URL, CP_INVENTORY_TABLE, DATABASE_URL,
    FORMS_APP_URL, FRONTEND_ORIGIN, GOOGLE_OAUTH_CLIENT_ID, LOG_LEVEL,
    PROPERTIES_DB_URL, SYNC_TOKEN

JWT_SECRET and INTERNAL_API_KEY are read here too. They are deployment secrets
rather than part of the documented `.env.example` surface. JWT_SECRET is
required — the app refuses to start without it (see backend/app.py).
"""
from __future__ import annotations

import os

from dotenv import load_dotenv

# Load backend/.env explicitly so secrets resolve regardless of the working
# directory the app is launched from (e.g. `python -m backend.app` from the repo
# root). A repo-root .env, if present, is honoured too but does not override
# values already set in the real environment or backend/.env.
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_BACKEND_DIR, ".env"))
load_dotenv()


# DB
DATABASE_URL          = os.environ.get("DATABASE_URL", "")
# Read-only handle for the acquisition Properties DB (visit scheduling lookups).
PROPERTIES_DB_URL     = os.environ.get("PROPERTIES_DB_URL", "")
# Read-only handle for CP Inventory Portal data. Optional — if unset, the
# /api/inventory list endpoint silently skips the CP match annotation.
CP_DB_URL             = os.environ.get("CP_DB_URL", "")
CP_INVENTORY_TABLE    = os.environ.get("CP_INVENTORY_TABLE", "submissions")

# Auth. JWT_SECRET is a required deployment secret — no insecure default; the
# app validates it at startup (see backend/app.py) and refuses to boot if unset.
JWT_SECRET            = os.environ.get("JWT_SECRET", "")
JWT_ALGORITHM         = "HS256"
JWT_EXPIRY_HOURS      = 24 * 7
GOOGLE_OAUTH_CLIENT_ID = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
ALLOWED_EMAIL_DOMAIN  = os.environ.get("ALLOWED_EMAIL_DOMAIN", "openhouse.in")

# Apps Script push sync
SYNC_TOKEN            = os.environ.get("SYNC_TOKEN", "")

# Forms integration (visit scheduling). FORMS_APP_URL is documented; the shared
# key defaults empty and the schedule endpoint reports "not configured" without it.
FORMS_APP_URL         = os.environ.get("FORMS_APP_URL", "")
INTERNAL_API_KEY      = os.environ.get("INTERNAL_API_KEY", "")

# ── Bonvoice PBX (click-to-call, auto-dialer, call log) ──────────────────
BONVOICE_BASE_URL       = os.environ.get("BONVOICE_BASE_URL", "https://backend.pbx.bonvoice.com")
BONVOICE_USERNAME       = os.environ.get("BONVOICE_USERNAME", "")
BONVOICE_PASSWORD       = os.environ.get("BONVOICE_PASSWORD", "")
BONVOICE_TOKEN          = os.environ.get("BONVOICE_TOKEN", "")
BONVOICE_DID            = os.environ.get("BONVOICE_DID", "")           # caller ID both parties see
BONVOICE_CHANNEL_ID     = os.environ.get("BONVOICE_CHANNEL_ID", "1")   # legA/legB channel id
BONVOICE_WEBHOOK_SECRET = os.environ.get("BONVOICE_WEBHOOK_SECRET", "")
BONVOICE_SYNC_INTERVAL_MINUTES = int(os.environ.get("BONVOICE_SYNC_INTERVAL_MINUTES", "15") or 15)
BONVOICE_SYNC_LOOKBACK_DAYS    = int(os.environ.get("BONVOICE_SYNC_LOOKBACK_DAYS", "1") or 1)


def bonvoice_base() -> str:
    """Every endpoint we use is served by the `backend.` host; the bare host
    (pbx.bonvoice.com) answers 405. Derive it rather than trust config: empty →
    default, missing scheme → https://, //pbx. → //backend.pbx. — so setting the
    bare host can't break calling."""
    base = (BONVOICE_BASE_URL or "").strip().rstrip("/")
    if not base:
        return "https://backend.pbx.bonvoice.com"
    if "://" not in base:
        base = "https://" + base
    if "//pbx." in base:
        base = base.replace("//pbx.", "//backend.pbx.", 1)
    return base


def bonvoice_configured() -> bool:
    """DID plus either a token or username+password."""
    return bool(BONVOICE_DID) and bool(BONVOICE_TOKEN or (BONVOICE_USERNAME and BONVOICE_PASSWORD))


# CORS
FRONTEND_ORIGIN       = os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173")

# Misc
LOG_LEVEL             = os.environ.get("LOG_LEVEL", "INFO")
