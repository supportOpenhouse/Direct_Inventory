"""Unit tests for OH-ID generator.

Run with `pytest backend/tests/test_oh_id.py` from the repo root.
DB-touching tests use a tiny in-memory fake cursor — no real Postgres needed.
"""
from __future__ import annotations

import pytest

from backend.services.oh_id import (
    _next_suffix,
    city_code,
    format_oh_id,
    next_oh_id,
)


# ---------- pure helpers ----------

def test_city_code_basic():
    assert city_code("Noida") == "N"
    assert city_code("noida") == "N"
    assert city_code("Greater Noida") == "N"
    assert city_code("Gurgaon") == "G"
    assert city_code("Gurugram") == "G"
    assert city_code("Ghaziabad") == "GH"


def test_city_code_unknown_raises():
    with pytest.raises(ValueError):
        city_code("Mumbai")
    with pytest.raises(ValueError):
        city_code("")


def test_format_oh_id_padding():
    assert format_oh_id("N", 1, "") == "OHLND0001"
    assert format_oh_id("N", 9999, "") == "OHLND9999"
    assert format_oh_id("N", 1, "A") == "OHLND0001A"
    assert format_oh_id("GH", 42, "B") == "OHLGHD0042B"


def test_next_suffix_progression():
    assert _next_suffix("") == "A"
    assert _next_suffix("A") == "B"
    assert _next_suffix("Y") == "Z"
    assert _next_suffix("Z") == "AA"
    assert _next_suffix("AA") == "AB"
    assert _next_suffix("AZ") == "BA"


# ---------- integration with fake cursor ----------

class FakeCursor:
    """Minimal fake of psycopg2 cursor backed by a dict of city -> (counter, suffix)."""

    def __init__(self, state: dict[str, tuple[int, str]]):
        self.state = state
        self._last = None

    def execute(self, sql: str, params: tuple):
        sql_norm = " ".join(sql.split())
        if sql_norm.startswith("SELECT counter, suffix FROM oh_id_counter"):
            (code,) = params
            self._last = ("select", code)
            return
        if sql_norm.startswith("UPDATE oh_id_counter"):
            counter, suffix, code = params
            self.state[code] = (counter, suffix)
            self._last = None
            return
        raise AssertionError(f"unexpected SQL: {sql_norm}")

    def fetchone(self):
        assert self._last and self._last[0] == "select"
        code = self._last[1]
        if code not in self.state:
            return None
        # Match psycopg2.RealDictCursor — rows are dicts keyed by column name.
        counter, suffix = self.state[code]
        return {"counter": counter, "suffix": suffix}


def test_next_oh_id_first_id_for_each_city():
    cur = FakeCursor({"N": (0, ""), "G": (0, ""), "GH": (0, "")})
    assert next_oh_id(cur, "Noida") == "OHLND0001"
    assert next_oh_id(cur, "Gurgaon") == "OHLGD0001"
    assert next_oh_id(cur, "Ghaziabad") == "OHLGHD0001"


def test_next_oh_id_sequential():
    cur = FakeCursor({"N": (5, "")})
    assert next_oh_id(cur, "Noida") == "OHLND0006"
    assert next_oh_id(cur, "Noida") == "OHLND0007"


def test_next_oh_id_rollover_to_suffix_A():
    cur = FakeCursor({"N": (9999, "")})
    assert next_oh_id(cur, "Noida") == "OHLND0001A"
    assert next_oh_id(cur, "Noida") == "OHLND0002A"


def test_next_oh_id_rollover_to_suffix_B():
    cur = FakeCursor({"G": (9999, "A")})
    assert next_oh_id(cur, "Gurgaon") == "OHLGD0001B"


def test_next_oh_id_greater_noida_uses_N_pool():
    cur = FakeCursor({"N": (10, "")})
    assert next_oh_id(cur, "Greater Noida") == "OHLND0011"
    assert cur.state["N"] == (11, "")


def test_next_oh_id_unknown_city():
    cur = FakeCursor({"N": (0, "")})
    with pytest.raises(ValueError):
        next_oh_id(cur, "Mumbai")


def test_next_oh_id_missing_counter_row():
    cur = FakeCursor({})  # no rows seeded
    with pytest.raises(RuntimeError):
        next_oh_id(cur, "Noida")
