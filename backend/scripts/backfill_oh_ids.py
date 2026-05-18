"""One-time backfill: assign oh_id to inventory rows missing one.

New rows already get an oh_id at insert time (manual create + sheet sync),
so this is only needed once to clean up legacy NULL/empty rows. Safe to
re-run — it's a no-op when nothing is missing.

Usage:
  python -m backend.scripts.backfill_oh_ids
"""
from __future__ import annotations

import logging

from ..db import get_conn
from ..services.oh_id import backfill_missing_oh_ids

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def main() -> None:
    conn = get_conn()
    try:
        result = backfill_missing_oh_ids(conn)
        conn.commit()
        print(f"filled={result['filled']} skipped={result['skipped']}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
