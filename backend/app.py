"""Flask entry point for Openhouse Direct Inventory Portal.

Local dev: `python -m backend.app`  (port 5060 by default to avoid clash with CP portal:5050)
Production (Render): gunicorn 'backend.app:app' --bind 0.0.0.0:$PORT
"""
from __future__ import annotations

import logging
import os

from flask import Flask, jsonify
from flask_cors import CORS

from . import config
from .api import activity as activity_api
from .api import auth as auth_api
from .api import inventory as inventory_api
from .api import rm_mapping as rm_mapping_api
from .api import sync as sync_api
from .api import users as users_api
from .api import visits as visits_api
from .db import get_conn, get_props_conn

logging.basicConfig(level=getattr(logging, config.LOG_LEVEL, logging.INFO))




def create_app() -> Flask:
    app = Flask(__name__)
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
    app.register_blueprint(inventory_api.bp)
    app.register_blueprint(rm_mapping_api.bp)
    app.register_blueprint(users_api.bp)
    app.register_blueprint(sync_api.bp)
    app.register_blueprint(visits_api.bp)
    app.register_blueprint(activity_api.bp)
    return app


app = create_app()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5060))
    app.run(host="0.0.0.0", port=port, debug=True)
