"""Postgres connection helpers. Two pools: app DB (read/write) and properties DB (read-only)."""
from __future__ import annotations

import psycopg2
from psycopg2.extras import RealDictCursor

from . import config


def get_conn():
    """App DB connection. Caller is responsible for commit/rollback/close."""
    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg2.connect(config.DATABASE_URL, cursor_factory=RealDictCursor)


def get_props_conn():
    """READ-ONLY properties DB. Never write."""
    if not config.PROPERTIES_DB_URL:
        raise RuntimeError("PROPERTIES_DB_URL is not set")
    conn = psycopg2.connect(config.PROPERTIES_DB_URL, cursor_factory=RealDictCursor)
    conn.set_session(readonly=True)
    return conn


def get_cp_conn():
    """READ-ONLY CP Inventory Portal DB. Returns None if CP_DB_URL is not set
    (e.g. local dev) so callers can degrade gracefully."""
    if not config.CP_DB_URL:
        return None
    conn = psycopg2.connect(config.CP_DB_URL, cursor_factory=RealDictCursor)
    conn.set_session(readonly=True)
    return conn
