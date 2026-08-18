"""Render cron entrypoint: pull-sync Bonvoice call records into call_logs.

One run_call_log_sync() pass — a rolling lookback window (BONVOICE_SYNC_LOOKBACK_DAYS)
upserted through the same path the webhook uses. Backfills history and re-covers any
call whose live callback was dropped. Re-persisting a record we hold is free (upsert
on (call_id, leg)). Schedule every 15 min in Render.

Run (Render cron, rootDir=backend):  python -m scripts.run_bonvoice_sync
Local (from repo root):              backend/.venv/bin/python -m backend.scripts.run_bonvoice_sync
"""
from __future__ import annotations

import logging
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
_REPO_ROOT = os.path.dirname(_BACKEND)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(_BACKEND, ".env"))  # local only; Render injects real env
except Exception:  # pragma: no cover
    pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bonvoice_sync_cron")


def main() -> int:
    from backend.api.bonvoice import run_call_log_sync

    # run_call_log_sync swallows its own errors (a failed pull must never kill the
    # scheduler) and logs the counts itself; the run is visible in Render cron logs.
    run_call_log_sync(trigger="cron")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
