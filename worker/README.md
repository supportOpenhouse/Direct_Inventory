# Auto-dialer worker

The Render **Background Worker** that runs the auto-dialer tick loop (every ~3s). It's a
thin runner — all the logic lives in [`backend/services/dialer.py`](../backend/services/dialer.py),
shared with the web API in `backend/api/dialer.py`.

## Deploy (Render)

Its own service, defined in [`backend/render.yaml`](../backend/render.yaml):

- **type:** `worker`  ·  **rootDir:** `worker`
- **build:** `pip install -r requirements.txt` (pulls `../backend/requirements.txt`)
- **start:** `python run_dialer.py`
- **env:** `DATABASE_URL` + the `BONVOICE_*` vars (set in the dashboard, `sync:false`).

The whole repo is checked out even though `rootDir` is `worker`, so `run_dialer.py` adds
the repo root to `sys.path` and imports `backend.*`.

## Why one process, no Redis

A single worker means no two ticks ring the same RM at once, and the DB claim
(`FOR UPDATE SKIP LOCKED`) stops two ticks claiming the same lead — the one thing the
reference used Redis for. If this ever scales past one worker, add a Postgres advisory
lock around `tick_all()`.

## Local

```sh
backend/.venv/bin/python worker/run_dialer.py
```
