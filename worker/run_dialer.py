"""Render Background Worker: the auto-dialer tick loop.

Deployed as its own Render service (rootDir: worker). The whole repo is still checked
out, so this adds the repo root to sys.path and imports the shared dialer core from
`backend` — the web API and this worker run the exact same code.

One process runs the loop, which is what keeps it simple: the DB claim
(FOR UPDATE SKIP LOCKED in _dial_next) stops two ticks claiming the same lead, and a
single worker means no two ticks ever ring the same RM at once — so no distributed lock
is needed (that's the one thing the reference used Redis for).

Run (Render worker, rootDir=worker):  python run_dialer.py
Local (from repo root):               backend/.venv/bin/python worker/run_dialer.py
"""
import logging
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(_REPO_ROOT, "backend", ".env"))  # local only; Render injects env
except Exception:  # pragma: no cover
    pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dialer_worker")


def main():
    from backend import config
    from backend.services.dialer import TICK_SECONDS, tick_all

    if not config.bonvoice_configured():
        # Still ticks — campaigns just can't place calls until Bonvoice is set up. This
        # keeps the queue draining logic (skips/reaper) working in the meantime.
        log.warning("dialer worker: Bonvoice not configured — calls won't be placed yet")
    log.info("auto-dialer worker started (tick every %ss)", TICK_SECONDS)

    while True:
        t0 = time.monotonic()
        try:
            tick_all()
        except Exception:  # noqa: BLE001 — the loop must survive anything
            log.exception("dialer: tick failed")
        # steady cadence regardless of how long the tick took
        time.sleep(max(0.0, TICK_SECONDS - (time.monotonic() - t0)))


if __name__ == "__main__":
    main()
