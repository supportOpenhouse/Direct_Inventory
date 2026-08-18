"""Find inventory society names that aren't in master_societies, and fuzzy-match
each to its closest master name to flag likely spelling mistakes.

Compares DISTINCT inventory.society (DATABASE_URL) against DISTINCT
master_societies.society_name (PROPERTIES_DB_URL), matched case/whitespace-
insensitively (the same normalisation the app uses). For every inventory
society with no exact (normalised) match, reports the closest master name, a
similarity %, and a verdict:
    likely typo    (>= 85%)  almost certainly the same society, misspelled
    possible       (>= 60%)  worth a human look
    not in master  (< 60%)   probably a genuinely new/unknown society

Output: CSV to stdout — Society, Leads, Closest master match, Similarity %,
Verdict — sorted by Leads desc (most impactful first). A summary line goes to
stderr, so redirecting stdout gives a clean CSV.

Run (from repo root):
    backend/.venv/bin/python -m backend.scripts.unmatched_societies > unmatched.csv
    backend/.venv/bin/python -m backend.scripts.unmatched_societies --selftest   # no DB
"""
from __future__ import annotations

import csv
import difflib
import os
import sys
from difflib import SequenceMatcher

try:
    from dotenv import load_dotenv
    _BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    load_dotenv(os.path.join(_BACKEND, ".env"))
except Exception:  # pragma: no cover
    pass


def norm(s):
    """Lower, trim, and collapse internal whitespace — the match key."""
    return " ".join((s or "").strip().lower().split())


def verdict(pct):
    if pct >= 85:
        return "likely typo"
    if pct >= 60:
        return "possible"
    return "not in master"


def analyse(inv_rows, master_names):
    """inv_rows: [(society, lead_count)]; master_names: [society_name].
    Returns [(society, leads, closest_master, similarity_pct, verdict)] for the
    inventory societies with no exact normalised match, sorted by leads desc."""
    master_by_norm = {}
    for name in master_names:
        master_by_norm.setdefault(norm(name), name)   # first display form wins
    master_norms = list(master_by_norm.keys())

    out = []
    for soc, cnt in inv_rows:
        n = norm(soc)
        if not n or n in master_by_norm:
            continue                                    # blank or an exact match
        close = difflib.get_close_matches(n, master_norms, n=1, cutoff=0.0)
        best_norm = close[0] if close else None
        pct = round(SequenceMatcher(None, n, best_norm).ratio() * 100) if best_norm else 0
        best_display = master_by_norm.get(best_norm, "") if best_norm else ""
        out.append((soc, cnt, best_display, pct, verdict(pct)))
    out.sort(key=lambda r: (-r[1], -r[3]))
    return out


def _selftest():
    master = ["Gaur City 2 14th Avenue", "Nirala Estate", "ATS Pious"]
    inv = [("Nirala Estate", 5), ("nirala  estate", 3), ("Nirala Estatee", 2), ("Random Tower XYZ", 1)]
    got = {r[0]: r for r in analyse(inv, master)}
    assert "Nirala Estate" not in got            # exact match excluded
    assert "nirala  estate" not in got           # normalised (extra space) match excluded
    assert got["Nirala Estatee"][2] == "Nirala Estate" and got["Nirala Estatee"][3] >= 85
    assert got["Random Tower XYZ"][4] == "not in master"
    print("selftest OK")


def main(argv) -> int:
    if "--selftest" in argv:
        _selftest()
        return 0

    import psycopg2
    from psycopg2.extras import RealDictCursor

    inv_url = os.environ.get("DATABASE_URL")
    props_url = os.environ.get("PROPERTIES_DB_URL")
    if not inv_url or not props_url:
        print("ERROR: DATABASE_URL and PROPERTIES_DB_URL must be set", file=sys.stderr)
        return 2

    conn = psycopg2.connect(inv_url)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """SELECT society, COUNT(*) AS n FROM inventory
                   WHERE society IS NOT NULL AND TRIM(society) <> ''
                   GROUP BY society"""
            )
            inv_rows = [(r["society"], r["n"]) for r in cur.fetchall()]
    finally:
        conn.close()

    pconn = psycopg2.connect(props_url)
    try:
        with pconn.cursor(cursor_factory=RealDictCursor) as pcur:
            pcur.execute(
                """SELECT DISTINCT society_name FROM master_societies
                   WHERE society_name IS NOT NULL AND TRIM(society_name) <> ''"""
            )
            master_names = [r["society_name"] for r in pcur.fetchall()]
    finally:
        pconn.close()

    rows = analyse(inv_rows, master_names)
    w = csv.writer(sys.stdout)
    w.writerow(["Society", "Leads", "Closest master match", "Similarity %", "Verdict"])
    for r in rows:
        w.writerow(r)
    print(
        f"{len(rows)} of {len(inv_rows)} distinct inventory societies not in master_societies "
        f"({len(master_names)} master names). Leads affected: {sum(r[1] for r in rows)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
