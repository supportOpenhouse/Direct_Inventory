"""Unit tests for the CP-match classifier — pure, no DB.

Run with `pytest backend/tests/test_cp_match.py` from the repo root.
Index tuples are (cp_id, floor, tower, unit_no, area), already normalised the
way _query_cp returns them.
"""
from __future__ import annotations

from backend.services.cp_match import _classify, _matches

ROW = {"society": "Palm Grove", "bedrooms": 3, "floor": "7", "tower": "B", "unit_no": "702", "area_sqft": 1500}


def idx(*cands):
    return {("palm grove", "3"): list(cands)}


def test_collects_every_match_perfect_first():
    # The old _classify stopped at the first perfect; _matches must keep them all.
    m = _matches(ROW, idx(
        (40, "7", "", "", 1500),      # partial: CP has no tower/unit
        (12, "7", "b", "702", 1500),  # perfect
        (33, "7", "b", "", None),     # partial: CP unit missing
        (91, "7", "b", "702", 1490),  # perfect (a second listing of the same flat)
    ))
    assert m == [
        {"id": 12, "match": "perfect"}, {"id": 91, "match": "perfect"},
        {"id": 33, "match": "partial"}, {"id": 40, "match": "partial"},
    ]
    assert _classify(ROW, idx((40, "7", "", "", 1500), (12, "7", "b", "702", 1500))) == "perfect"


def test_excluded_candidates():
    m = _matches(ROW, idx(
        (1, "9", "b", "702", 1500),   # floor mismatch (both matchable)
        (2, "7", "c", "305", 1500),   # both sides have tower+unit, different flat
        (3, "higher", "", "", 1800),  # floor unusable → area check, 300 sqft off
    ))
    assert m == [] and _classify(ROW, idx((2, "7", "c", "305", 1500))) is None


def test_unmatchable_row():
    assert _matches({**ROW, "bedrooms": None}, idx((1, "7", "b", "702", 1500))) == []
    assert _matches({**ROW, "society": "Elsewhere"}, idx((1, "7", "b", "702", 1500))) == []
