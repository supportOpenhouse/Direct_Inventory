"""Render cron entrypoint: pull supply-closure stages from
PROPERTIES_DB.cp_inventory_status into inventory (Supply Closure Tracker).

One run_supply_sync() pass — one-way, mirrors direct_stage/supply_status onto
inventory.stage/stage_reason. Keeps the portal in sync without waiting for
someone to open the Supply Closure Tracker tab. Schedule every 5 min in Render.

Run (Render cron, rootDir=backend):  python -m scripts.run_supply_sync
Local (from repo root):              backend/.venv/bin/python -m backend.scripts.run_supply_sync
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
log = logging.getLogger("supply_sync_cron")


def main() -> int:
    from backend.services.supply_sync import run_supply_sync

    # No actor → no activity-log row (avoids flooding it every 5 min); the run
    # is visible in the Render cron logs instead.
    result = run_supply_sync()
    log.info("supply-sync: source_rows=%s matched=%s updated=%s",
             result.get("source_rows"), result.get("matched"), result.get("updated"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
