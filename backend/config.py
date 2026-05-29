"""Runtime config loaded from environment variables."""
from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


def _required(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        raise RuntimeError(f"Missing required env var: {key}")
    return val


# DB
DATABASE_URL          = os.environ.get("DATABASE_URL", "")
PROPERTIES_DB_URL     = os.environ.get("PROPERTIES_DB_URL", "")
# Read-only handle for CP Inventory Portal data. Optional — if unset, the
# /api/inventory list endpoint silently skips the CP match annotation.
CP_DB_URL             = os.environ.get("CP_DB_URL", "")
CP_INVENTORY_TABLE    = os.environ.get("CP_INVENTORY_TABLE", "inventory")

# Auth
JWT_SECRET            = os.environ.get("JWT_SECRET", "dev-secret-do-not-use-in-prod")
JWT_ALGORITHM         = "HS256"
JWT_EXPIRY_HOURS      = 24 * 7
GOOGLE_OAUTH_CLIENT_ID = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
ALLOWED_EMAIL_DOMAIN  = os.environ.get("ALLOWED_EMAIL_DOMAIN", "openhouse.in")

# Apps Script push sync
SYNC_TOKEN            = os.environ.get("SYNC_TOKEN", "")

# Forms integration
FORMS_APP_URL         = os.environ.get("FORMS_APP_URL", "")
INTERNAL_API_KEY      = os.environ.get("INTERNAL_API_KEY", "")

# CORS
FRONTEND_ORIGIN       = os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173")

# Misc
LOG_LEVEL             = os.environ.get("LOG_LEVEL", "INFO")
