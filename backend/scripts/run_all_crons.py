"""Render cron entrypoint: every scheduled job in one run, every 10 min.

Replaces the three separate Render crons (supply-sync, assign-missing,
backfill-locality). Jobs run in sequence, each isolated so one failing doesn't
skip the rest — the same guarantee the separate crons gave. The run exits 1 if
any job failed, so Render still marks it red.

Order: supply-sync first (stages feed what RMs see), then assign-missing, then
locality. None depends on another's output.

Run (Render cron, rootDir=backend):  python -m scripts.run_all_crons
Local (from repo root):              backend/.venv/bin/python -m backend.scripts.run_all_crons
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

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("all_crons")


def main() -> int:
    # Each module handles its own dotenv load + path setup on import.
    from backend.scripts import backfill_locality_from_master, run_assign_missing, run_supply_sync

    jobs = [
        ("supply-sync", run_supply_sync.main),  # also runs the Bonvoice call-log pull
        ("assign-missing", run_assign_missing.main),
        ("backfill-locality", backfill_locality_from_master.main),
    ]
    failed = []
    for name, job in jobs:
        log.info("── %s: start", name)
        try:
            rc = job()
        except Exception:  # noqa: BLE001 — isolate jobs; failure is still reported via exit code
            log.exception("── %s: crashed", name)
            failed.append(name)
            continue
        if rc:
            log.error("── %s: exited %s", name, rc)
            failed.append(name)
        else:
            log.info("── %s: done", name)

    if failed:
        log.error("failed jobs: %s", ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
