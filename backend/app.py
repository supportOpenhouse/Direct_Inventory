"""Flask entry point for Openhouse Direct Inventory Portal.

Local dev: `python -m backend.app`  (port 5060 by default to avoid clash with CP portal:5050)
Production (Render): gunicorn 'backend.app:app' --bind 0.0.0.0:$PORT
"""
from __future__ import annotations

import logging
import os
from decimal import Decimal

from flask import Flask, jsonify
from flask.json.provider import DefaultJSONProvider
from flask_cors import CORS

from . import config


class _JSONProvider(DefaultJSONProvider):
    """Emit NUMERIC columns (psycopg2 returns them as Decimal — e.g.
    inventory.area_sqft) as JSON numbers rather than Flask's default string,
    so the API matches the numeric shape the frontend mock contract uses.
    Integral values become ints; everything else falls back to the default
    handler (date/datetime/uuid/etc.).
    """

    @staticmethod
    def default(o):
        if isinstance(o, Decimal):
            return int(o) if o == o.to_integral_value() else float(o)
        return DefaultJSONProvider.default(o)
from .api import activity as activity_api
from .api import auth as auth_api
from .api import geo as geo_api
from .api import home as home_api
from .api import post_token as post_token_api
from .api import sync as sync_api
from .api import tickets as tickets_api
from .api import users as users_api
from .api import visits as visits_api
from .api.inventory import bp as inventory_bp
from .db import get_conn, get_props_conn

logging.basicConfig(level=getattr(logging, config.LOG_LEVEL, logging.INFO))


def create_app() -> Flask:
    if not config.JWT_SECRET:
        raise RuntimeError(
            "JWT_SECRET is not set. It is a required deployment secret — set it "
            "in the environment (backend/.env) before starting the app."
        )

    app = Flask(__name__)
    app.json = _JSONProvider(app)
    CORS(app, origins=[config.FRONTEND_ORIGIN], supports_credentials=False)

    @app.get("/api/health")
    def health():
        out = {"status": "ok", "db": "unknown", "properties_db": "unknown"}
        try:
            c = get_conn()
            with c, c.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
            c.close()
            out["db"] = "connected"
        except Exception as e:
            out["db"] = f"error: {e}"
        try:
            c = get_props_conn()
            with c, c.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
            c.close()
            out["properties_db"] = "connected"
        except Exception as e:
            out["properties_db"] = f"error: {e}"
        return jsonify(out)

    app.register_blueprint(auth_api.bp)
    app.register_blueprint(inventory_bp)
    app.register_blueprint(home_api.bp)
    app.register_blueprint(post_token_api.bp)
    app.register_blueprint(users_api.bp)
    app.register_blueprint(sync_api.bp)
    app.register_blueprint(visits_api.bp)
    app.register_blueprint(activity_api.bp)
    app.register_blueprint(geo_api.bp)
    app.register_blueprint(tickets_api.bp)
    return app


app = create_app()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5060))
    debug = os.environ.get("FLASK_DEBUG", "").strip().lower() in ("1", "true", "yes", "on")
    app.run(host="0.0.0.0", port=port, debug=debug)
