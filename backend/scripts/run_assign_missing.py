"""Render cron entrypoint: backfill POC assignment for leads that came in
UNASSIGNED (e.g. bulk-seeded, or before an RM's scope was set).

Runs one assign_missing_batch(mode='missing') pass — cheap, only touches rows
with an empty assigned_rm_ids, and NEVER overwrites an existing assignment. The
batch drains as much as fits in its time budget; repeated cron runs catch up a
large backlog. Schedule it in Render (every ~15 min).

Run (Render cron, rootDir=backend):  python -m scripts.run_assign_missing
Local (from repo root):              backend/.venv/bin/python -m backend.scripts.run_assign_missing
"""
from __future__ import annotations

import logging
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
_REPO_ROOT = os.path.dirname(_BACKEND)
# Make the `backend` package importable regardless of cwd (mirrors wsgi.py).
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(_BACKEND, ".env"))  # local only; Render injects real env
except Exception:  # pragma: no cover - dotenv optional in prod
    pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("assign_missing_cron")


def main() -> int:
    from backend.db import get_conn
    from backend.services.assignment import assign_missing_batch

    conn = get_conn()
    try:
        result = assign_missing_batch(conn, mode="missing")
    finally:
        conn.close()
    log.info("assign-missing: updated=%s scanned=%s remaining=%s",
             result.get("updated"), result.get("scanned"), result.get("remaining"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
