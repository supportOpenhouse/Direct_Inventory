"""WSGI entry point for Render / gunicorn.

Render's service Root Directory is `backend/`, so gunicorn runs with this
folder as cwd. We add the repo root to sys.path so the `backend` package
(which uses relative imports like `from . import config`) is importable.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from backend.app import app  # noqa: E402

# Auto-dialer runs in-process as a daemon thread (one per gunicorn worker); a Postgres
# advisory lock elects a single ticker so no RM is double-dialled. Started here (not in
# create_app) so it only runs under gunicorn — never during tests/CLI that import the app.
from backend.services.dialer import start_background_dialer  # noqa: E402
start_background_dialer()

__all__ = ["app"]
