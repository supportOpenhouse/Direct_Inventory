"""RM → societies in area scope, as CSV (one row per RM-society pair).

Each RM's (role='rm') scope societies =
    the societies assigned directly on the user (users.society)
  ∪ every society of each micro-market assigned to the user
    (master_societies.society_name WHERE micro_market = the RM's micro-market).

Cross-DB: users live in the inventory DB (DATABASE_URL); the micro-market →
society map lives in the Properties DB (PROPERTIES_DB_URL, master_societies).
Micro-markets are matched case/whitespace-insensitively (same as the app).

Output: CSV with two columns — RM, Society — sorted by RM then society.

Run (from repo root):
    backend/.venv/bin/python -m backend.scripts.rm_area_societies            # -> rm_societies.csv
    backend/.venv/bin/python -m backend.scripts.rm_area_societies out.csv    # -> out.csv
    backend/.venv/bin/python -m backend.scripts.rm_area_societies -          # -> stdout
    backend/.venv/bin/python -m backend.scripts.rm_area_societies --selftest # logic check, no DB
"""
from __future__ import annotations

import csv
import os
import sys

try:
    from dotenv import load_dotenv
    _BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    load_dotenv(os.path.join(_BACKEND, ".env"))
except Exception:  # pragma: no cover
    pass

_norm = lambda s: (s or "").strip().lower()  # noqa: E731


def scope_societies(direct, micro_markets, mm_map):
    """Union of an RM's directly-assigned societies and every society under the
    micro-markets they're assigned. `mm_map` maps normalised micro-market → set
    of society names. Returns a sorted, de-duplicated list.
    """
    out = {s.strip() for s in (direct or []) if s and s.strip()}
    for mm in (micro_markets or []):
        out |= mm_map.get(_norm(mm), set())
    return sorted(out, key=str.lower)


def main(argv) -> int:
    if "--selftest" in argv:
        mm_map = {"sector 150": {"ATS Pious", "Godrej Nurture"}, "noida expressway": {"ATS Pious"}}
        # direct + one micro-market, with an overlap that must de-dupe (ATS Pious).
        got = scope_societies(["Prateek Edifice", "ATS Pious"], ["Sector 150 ", "noida EXPRESSWAY"], mm_map)
        assert got == ["ATS Pious", "Godrej Nurture", "Prateek Edifice"], got
        # no micro-market → just the direct societies
        assert scope_societies(["A"], [], mm_map) == ["A"]
        # unknown micro-market contributes nothing
        assert scope_societies([], ["nowhere"], mm_map) == []
        print("selftest OK")
        return 0

    import psycopg2  # deferred so --selftest runs without the DB driver installed
    from psycopg2.extras import RealDictCursor

    inv_url = os.environ.get("DATABASE_URL")
    props_url = os.environ.get("PROPERTIES_DB_URL")
    if not inv_url or not props_url:
        print("ERROR: DATABASE_URL and PROPERTIES_DB_URL must be set", file=sys.stderr)
        return 2

    # 1) micro-market (normalised) -> set of society names, from master_societies.
    pconn = psycopg2.connect(props_url)
    try:
        with pconn.cursor(cursor_factory=RealDictCursor) as pcur:
            pcur.execute(
                """SELECT micro_market, society_name FROM master_societies
                   WHERE micro_market IS NOT NULL AND TRIM(micro_market) <> ''
                     AND society_name IS NOT NULL AND TRIM(society_name) <> ''"""
            )
            mm_map: dict[str, set] = {}
            for r in pcur.fetchall():
                mm_map.setdefault(_norm(r["micro_market"]), set()).add(r["society_name"].strip())
    finally:
        pconn.close()

    # 2) RMs with their assigned scope arrays.
    conn = psycopg2.connect(inv_url)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """SELECT name, email, society, micro_market
                   FROM users
                   WHERE role = 'rm'
                   ORDER BY name NULLS LAST, email"""
            )
            rms = cur.fetchall()
    finally:
        conn.close()

    # 3) Emit CSV — one row per (RM, society).
    out_path = next((a for a in argv[1:] if not a.startswith("-")), "rm_societies.csv")
    fh = sys.stdout if out_path == "-" else open(out_path, "w", newline="", encoding="utf-8")
    try:
        w = csv.writer(fh)
        w.writerow(["RM", "Society"])
        rows = 0
        for u in rms:
            label = u["name"] or u["email"]
            for soc in scope_societies(u["society"], u["micro_market"], mm_map):
                w.writerow([label, soc])
                rows += 1
    finally:
        if fh is not sys.stdout:
            fh.close()
    if out_path != "-":
        print(f"wrote {rows} rows for {len(rms)} RMs -> {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
