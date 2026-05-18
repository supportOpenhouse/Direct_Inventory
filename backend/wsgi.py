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

__all__ = ["app"]
