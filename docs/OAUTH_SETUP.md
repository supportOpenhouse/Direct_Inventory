# Google OAuth setup — Direct Inventory Portal

You only need **one** Google credential: an **OAuth 2.0 Web Client** for login.
Sheet sync uses Apps Script push (no service account, no Sheets API needed).

Total time: ~5 min.

---

## 0. Pre-requisites

- A GCP project. Create one if needed at https://console.cloud.google.com → top bar → New Project. Name it `openhouse-direct-portal`.
- Workspace admin access for `openhouse.in` (only needed once, to verify the consent screen).

---

## 1. OAuth consent screen

1. https://console.cloud.google.com/apis/credentials/consent → **Internal** (not External).
   - Internal restricts logins to your `openhouse.in` Workspace, which is exactly what we want.
2. App name: `Openhouse Direct Inventory`
3. User support email: `support@openhouse.in`  *(this is the Workspace admin — also the contact who must approve the consent screen)*
4. Developer contact: `support@openhouse.in`
5. Save.
6. **Scopes** step → click *Add or remove scopes* → tick `.../auth/userinfo.email` and `.../auth/userinfo.profile` → save.
7. Skip test users (Internal apps don't need them).

---

## 2. OAuth Web Client (for login)

1. https://console.cloud.google.com/apis/credentials → **Create Credentials → OAuth client ID**.
2. Application type: **Web application**. Name: `Direct Inventory Web`.
3. Authorized JavaScript origins:
   - `http://localhost:5174` (local dev)
   - `https://direct-inventory-portal.vercel.app` (replace with the actual Vercel URL once provisioned)
4. Authorized redirect URIs: leave empty (Google Identity Services / `@react-oauth/google` does not use redirect URIs for the credential flow).
5. Create → copy **Client ID**. *The Client Secret is not used by this flow — store it in your password manager but don't paste it anywhere in this codebase.*
6. Plug it in:
   - `backend/.env` → `GOOGLE_OAUTH_CLIENT_ID=...`
   - `frontend/.env` → `VITE_GOOGLE_OAUTH_CLIENT_ID=...`
   - Vercel & Render: set the same env vars in their dashboards.

The backend `verify_oauth2_token` call in `backend/api/auth.py` validates the audience against this Client ID.

That's it for Google credentials. **No service account needed.**

---

## 3. Daily sync — Apps Script push

Sheet sync is implemented as an Apps Script trigger that POSTs sheet rows to the
backend daily. No service account, no Sheets API to enable.

1. Open the data sheet (id `1cTKri04m4HEj_JhTxH9FE9h70RL5gRMv4yGtv9g1BQM`).
2. **Extensions → Apps Script**. Paste [`apps_script/sync_direct_inventory.gs`](../apps_script/sync_direct_inventory.gs) as `Code.gs`.
3. **Project Settings → Time zone**: set to `Asia/Kolkata`.
4. **Project Settings → Script properties** → add:
   - `BACKEND_URL` = `https://direct-inventory-portal.onrender.com`
   - `SYNC_TOKEN` = the same value as the backend's `SYNC_TOKEN` env var (Render will auto-generate one — copy it from Render's env vars after first deploy)
5. From the Apps Script editor, run `installTrigger()` once. Approve the OAuth prompt.
6. Verify: run `runSync()` manually and check **View → Logs** for `HTTP 200` and the row counts.

After install, `runSync` fires automatically every day at ~11:30 IST.

---

## 4. Sanity check

```bash
# 1. backend health
curl https://direct-inventory-portal.onrender.com/api/health
# expect: {"db":"connected","properties_db":"connected","status":"ok"}

# 2. push path (mimics what Apps Script does)
curl -X POST https://direct-inventory-portal.onrender.com/api/sync/sheet \
     -H "X-Sync-Token: $SYNC_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"rows":[{"source":"99acres","city":"Noida","society":"Test","listing_link":"https://example.com/x1"}]}'
# expect: {"fetched":1,"inserted":1,"updated":0,"skipped":0,"errors":0}
```

If a row is silently skipped, check that:
- `listing_link` is non-empty (dedup key — required)
- `city` is one of `Noida`, `Greater Noida`, `Gurgaon`, `Gurugram`, `Ghaziabad`
