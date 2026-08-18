# Bonvoice calling — index

Bonvoice is the PBX behind every phone call the portal places or records. No audio
ever touches the browser: the laptop only *triggers* a call, Bonvoice rings the RM's
own mobile, and bridges the lead in once the RM picks up.

One doc per feature:

| Doc | Feature |
|---|---|
| [click-to-call.md](click-to-call.md) | The 📞 button on a lead — one-off bridged call |
| [auto-dialer.md](auto-dialer.md) | Campaigns: rule tree → queue → keep every RM on a call |
| [live-calls.md](live-calls.md) | What the RM sees while a campaign dials them (SSE) |
| [call-log-webhook.md](call-log-webhook.md) | Lifecycle callbacks → `call_logs`, slot release |
| [call-record-sync.md](call-record-sync.md) | Pull-based backfill + the 15-min scheduled job |
| [call-log-page.md](call-log-page.md) | Admin Call Log, filters, recordings, per-lead history |
| [configuration.md](configuration.md) | Env vars, base-URL rewrite, webhook setup, failure modes |

## The shape of it

```
 CallButton / auto-dialer tick
        │  POST /autoDialManagement/autoCallBridging/   (eventID + callBackParams)
        ▼
   Bonvoice PBX ──rings leg A (RM handset)──▶ RM answers ──dials leg B (lead)──▶ lead
        │
        ├── push: up to 6 callbacks per conversation → POST /v1/bonvoice/webhook
        │        (0 initiated, 1 answered, 2 hangup, per leg)
        │
        └── pull: POST /crm/callrecords/  ← 15-min scheduler + admin "Sync" button
                  GET  /get-autocall-log/{eventID}/  ← dialer poller

                          ▼
                     call_logs  (one row per LEG, upsert on (call_id, leg))
                     dial_queue (hangup frees the RM's slot → next lead dials)
```

Push is the fast path; the pull paths exist so nothing depends on a callback actually
arriving. See [call-record-sync.md](call-record-sync.md).

## Code map

| Layer | File |
|---|---|
| Bridge, webhook, sync, call-log API | [backend/app/routers/bonvoice.py](../../backend/app/routers/bonvoice.py) |
| Campaign CRUD + rule builder API | [backend/app/routers/dialer.py](../../backend/app/routers/dialer.py) |
| Rule compiler + the dial tick | [backend/app/services/dialer.py](../../backend/app/services/dialer.py) |
| RM-facing snapshot + SSE | [backend/app/routers/live_calls.py](../../backend/app/routers/live_calls.py) |
| Event fan-out (Redis / in-process) | [backend/app/events.py](../../backend/app/events.py) |
| `call_logs`, `dial_campaigns`, `dial_queue` | [backend/app/models.py](../../backend/app/models.py) |
| Settings + base-URL rewrite | [backend/app/config.py](../../backend/app/config.py) |
| Scheduled sync job | [backend/app/workers/scheduler.py](../../backend/app/workers/scheduler.py) |
| Call button / player / pages | [frontend/src/components/CallButton.tsx](../../frontend/src/components/CallButton.tsx), [RecordingPlayer.tsx](../../frontend/src/components/RecordingPlayer.tsx), [CallLog.tsx](../../frontend/src/pages/CallLog.tsx), [LiveCalls.tsx](../../frontend/src/pages/LiveCalls.tsx), [Dialer.tsx](../../frontend/src/pages/Dialer.tsx) |
| Tests | [backend/tests/test_bonvoice.py](../../backend/tests/test_bonvoice.py), [test_dialer.py](../../backend/tests/test_dialer.py), [test_live_calls.py](../../backend/tests/test_live_calls.py) |

> Bonvoice ≠ Huvo. Huvo (`routers/huvo*.py`) is a separate call-intelligence vendor
> that posts transcripts and summaries; it places no calls.
