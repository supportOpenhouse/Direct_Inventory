"""Postgres connection helpers.

Three lazily-created connection pools, one per DSN: app DB (read/write,
maxconn 10), properties DB (read-only, maxconn 5) and CP Inventory Portal DB
(read-only, maxconn 3). get_conn()/get_props_conn()/get_cp_conn() hand out a
thin wrapper that behaves exactly like a raw psycopg2 connection, except that
.close() returns the connection to its pool (rolling back any open
transaction, and discarding broken connections) instead of closing it. If a
pool is exhausted we fall back to a one-off direct connection so requests
never fail on pool limits.
"""
from __future__ import annotations

import threading

import psycopg2
import psycopg2.pool
from psycopg2.extras import RealDictCursor

from . import config

_pools: dict[str, psycopg2.pool.ThreadedConnectionPool] = {}
_pools_lock = threading.Lock()

# TCP keepalives so idle pooled connections aren't silently killed by the
# Neon proxy / NAT between Render and the database.
_KEEPALIVE_KW = dict(keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3)


def _get_pool(dsn: str, maxconn: int) -> psycopg2.pool.ThreadedConnectionPool:
    """Lazily create (once, thread-safely) and return the pool for ``dsn``."""
    pool = _pools.get(dsn)
    if pool is None:
        with _pools_lock:
            pool = _pools.get(dsn)
            if pool is None:
                pool = psycopg2.pool.ThreadedConnectionPool(
                    1, maxconn, dsn, cursor_factory=RealDictCursor, **_KEEPALIVE_KW
                )
                _pools[dsn] = pool
    return pool


def _ping(conn) -> bool:
    """True if the connection still reaches the server. Neon (serverless)
    drops every pooled socket when its compute suspends, and conn.closed
    stays False client-side — a cheap SELECT 1 is the only reliable check."""
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        conn.rollback()  # don't hand out a conn with the ping's txn open
        return True
    except Exception:
        return False


class _PooledConnection:
    """Thin proxy over a psycopg2 connection that returns it to its pool on
    .close() instead of closing it. Everything else (cursor/commit/rollback/
    ``with conn:``/attribute access) is delegated to the real connection, so
    callers use it exactly like before. ``pool`` is None for direct fallback
    connections, in which case .close() really closes."""

    __slots__ = ("_conn", "_pool")

    def __init__(self, conn, pool):
        object.__setattr__(self, "_conn", conn)
        object.__setattr__(self, "_pool", pool)

    def close(self):
        conn, pool = self._conn, self._pool
        if pool is None:
            conn.close()
            return
        try:
            if conn.closed:
                pool.putconn(conn, close=True)
                return
            status = conn.info.transaction_status
            if status == psycopg2.extensions.TRANSACTION_STATUS_UNKNOWN:
                # Broken connection — discard rather than recycle.
                pool.putconn(conn, close=True)
                return
            if status != psycopg2.extensions.TRANSACTION_STATUS_IDLE:
                try:
                    conn.rollback()
                except Exception:
                    # Connection died mid-request — discard, never re-pool,
                    # and never let close() mask the caller's exception.
                    pool.putconn(conn, close=True)
                    return
            pool.putconn(conn)
        except psycopg2.pool.PoolError:
            # Pool closed/full of strangers — just drop the connection.
            try:
                conn.close()
            except Exception:
                pass

    # ``with conn:`` — special methods bypass __getattr__, so delegate
    # explicitly. Return self so ``with get_conn() as conn:`` also works.
    def __enter__(self):
        self._conn.__enter__()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return self._conn.__exit__(exc_type, exc_val, exc_tb)

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def __setattr__(self, name, value):
        setattr(self._conn, name, value)


def _checkout(dsn: str, maxconn: int, readonly: bool = False) -> _PooledConnection:
    """Get a connection from the pool for ``dsn``, skipping any that the
    server dropped while idle. On pool exhaustion (PoolError) fall back to a
    one-off direct connection so requests never 500 on pool limits."""
    try:
        pool = _get_pool(dsn, maxconn)
        conn = pool.getconn()
        # Each failed ping discards that conn (freeing its slot), so after
        # maxconn+1 attempts the database itself is unreachable — raise
        # rather than loop forever creating doomed connections.
        attempts = 0
        while conn.closed or not _ping(conn):
            pool.putconn(conn, close=True)
            attempts += 1
            if attempts > maxconn:
                raise psycopg2.OperationalError("database unreachable (pre-ping failed)")
            conn = pool.getconn()
    except psycopg2.pool.PoolError:
        conn = psycopg2.connect(dsn, cursor_factory=RealDictCursor, **_KEEPALIVE_KW)
        if readonly:
            conn.set_session(readonly=True)
        return _PooledConnection(conn, None)
    if readonly:
        conn.set_session(readonly=True)
    return _PooledConnection(conn, pool)


def get_conn():
    """App DB connection (pooled). Caller is responsible for commit/rollback/close."""
    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set")
    return _checkout(config.DATABASE_URL, maxconn=10)


def get_props_conn():
    """READ-ONLY properties DB (pooled). Never write."""
    if not config.PROPERTIES_DB_URL:
        raise RuntimeError("PROPERTIES_DB_URL is not set")
    return _checkout(config.PROPERTIES_DB_URL, maxconn=5, readonly=True)


def get_cp_conn():
    """READ-ONLY CP Inventory Portal DB (pooled). Returns None if CP_DB_URL is
    not set (e.g. local dev) so callers can degrade gracefully."""
    if not config.CP_DB_URL:
        return None
    return _checkout(config.CP_DB_URL, maxconn=3, readonly=True)
