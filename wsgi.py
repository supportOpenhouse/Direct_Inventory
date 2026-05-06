"""WSGI entry point for Render / gunicorn.

Lives at the repo root so `gunicorn wsgi:app` works regardless of the working
directory. Imports the Flask app from the `backend` package.
"""
from backend.app import app

__all__ = ["app"]
