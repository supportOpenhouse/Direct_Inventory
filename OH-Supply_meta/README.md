# OH Supply — Meta lead-ad landing page

A standalone, single-page lead capture form for Meta (Facebook/Instagram) lead
ads. It is deployed **separately** from the main app but writes to the **same
Postgres database**, into its own table: `meta_ads_responses`.

```
public/index.html    the landing page + 4-screen form (plain HTML/CSS/JS)
public/img/          hero images, content-hashed and cached for a year
api/lead.js          POST /api/lead        — verifies OTP, inserts the lead
api/otp/send.js      POST /api/otp/send    — generates a code, SMSes it
api/otp/verify.js    POST /api/otp/verify  — checks a code
api/societies.js     GET  /api/societies   — the societies we cover, cached
api/_lib.js          pools, phone/OTP helpers shared by the functions
api/_kaleyra.js      Kaleyra SMS client
schema.sql           both tables (idempotent)
vercel.json          security + cache headers; no framework build
```

## Two databases

This page talks to both of the main app's databases, in opposite directions:

| Env var             | Direction  | Used for                                              |
| ------------------- | ---------- | ----------------------------------------------------- |
| `DATABASE_URL`      | write      | `meta_ads_responses` + `meta_otp_verifications`       |
| `PROPERTIES_DB_URL` | read-only  | `master_societies` for the society dropdown            |

Both values are the same ones already in `backend/.env`.

SMS goes through Kaleyra (India region), configured with `KALEYRA_API_KEY`,
`KALEYRA_ACCOUNT_ID`, `KALEYRA_SMS_SENDER`, `KALEYRA_OTP_TEMPLATE_ID` and
`KALEYRA_OTP_BODY`. See `.env.example`.

**`KALEYRA_OTP_BODY` must match the DLT-registered template character for
character** — Indian carriers reject any mismatch, and the failure looks like
"sent successfully, never arrived". `{otp}` is replaced with the code.

## How it works

The form is four screens: **phone → OTP → details → review**.

1. Someone taps the ad and lands on `/` with Meta's tracking params in the URL
   (`fbclid`, `utm_*`, `campaign_id`, …).
2. Those params are read **once on page load** and held in memory — by submit
   time a stray navigation could have cleared them.
3. On load the page also fetches `/api/societies` and builds the society
   autocomplete from it, filtered to the city chosen on the details screen.
4. **Phone screen** → `/api/otp/send` generates a 6-digit code, sends it via
   Kaleyra, and stores only its hash.
5. **OTP screen** → `/api/otp/verify` checks the code and marks the row
   verified. Five wrong guesses locks that code; resend is throttled.
6. **Review screen** → `/api/lead` claims the verified code (marking it
   consumed) and inserts the lead in one transaction, returning a reference
   like `OH00042`.

If a step fails the form stays on screen with an error, so nothing the person
typed is lost.

### The OTP gate is enforced server-side

`/api/lead` refuses any submission whose phone has no verified, unconsumed,
unexpired code. The browser also sends a `phone_verified` flag — it is
**ignored**, because anyone can POST it with curl. Codes are stored as
`sha256(code + phone)`, never plaintext, and each one is good for exactly one
lead.

## Database

Both tables already exist in the shared database, created from `schema.sql`.
It is idempotent — re-running it is safe and changes nothing.

```bash
psql "$DATABASE_URL" -f schema.sql
```

`meta_ads_responses` and `meta_otp_verifications` are the only tables this
project touches.

Useful queries:

```sql
-- recent leads
SELECT created_at, name, phone, city, configuration, society, expected_price_lacs
FROM meta_ads_responses ORDER BY created_at DESC LIMIT 50;

-- leads per campaign
SELECT utm_campaign, campaign_id, count(*)
FROM meta_ads_responses GROUP BY 1, 2 ORDER BY 3 DESC;
```

## Deploying to Vercel

This folder is its own Vercel project, separate from the main app. The one
setting that matters is **Root Directory** — it must point at this folder, not
the repo root.

### Via the dashboard

1. **Add New → Project**, import the `Direct_Inventory` repo.
2. **Root Directory** → `OH-Supply_meta`.
3. Framework Preset: **Other**. Leave build/output commands empty — there is no
   build step; `public/` is served statically and `api/` becomes functions.
4. **Environment Variables** → add `DATABASE_URL` and `PROPERTIES_DB_URL` (same
   values as `backend/.env`) plus the five `KALEYRA_*` variables, for Production
   (and Preview, if you want previews to work too). Without `PROPERTIES_DB_URL`
   the society dropdown falls back to free text; without the Kaleyra
   credentials `/api/otp/send` returns 503 and nobody can get past screen one.
5. Deploy.

### Via the CLI

```bash
cd OH-Supply_meta
vercel link                       # create/select a NEW project, not the main one
vercel env add DATABASE_URL production
vercel env add PROPERTIES_DB_URL production
for v in KALEYRA_API_KEY KALEYRA_ACCOUNT_ID KALEYRA_SMS_SENDER \
         KALEYRA_OTP_TEMPLATE_ID KALEYRA_OTP_BODY; do
  vercel env add "$v" production
done
vercel --prod
```

### After deploying

Point the Meta ad's destination URL at the deployment, keeping the tracking
params Meta appends. Then submit one real test lead and confirm it lands:

```sql
SELECT * FROM meta_ads_responses ORDER BY id DESC LIMIT 1;
```

A real phone is needed for that test — the OTP is genuinely sent and checked.

## Local development

```bash
npm install
cp .env.example .env.local    # paste the real DB URLs + Kaleyra credentials
vercel dev                    # serves the page and all functions together
```

`vercel dev` is what you want rather than opening `index.html` directly — the
page calls same-origin `/api/*` routes that only exist under the dev server.

Note that local testing sends **real SMS** to whatever number you enter.

## Notes

- **Connection footprint.** Each warm function instance holds at most two
  pooled connections per database and drops them after 10s idle, so a traffic
  spike can't exhaust either connection limit and starve the main app. Use
  Neon's pooler endpoint (`-pooler` in the host name) for both URLs.
- **Personal data.** Leads record name, phone, email and an explicit consent
  flag; no IP or user agent. `meta_otp_verifications` *does* store the caller
  IP, purely to rate-limit SMS sends — worth a retention policy, since nothing
  prunes it today (see below).
- **OTP rows accumulate.** Nothing deletes them. They are small, but a
  periodic cleanup is worth adding:

  ```sql
  DELETE FROM meta_otp_verifications WHERE created_at < now() - interval '30 days';
  ```
- **SMS abuse.** Sends are throttled per number (5/hour, 30s apart) and per IP
  (15/hour); verification allows 5 wrong guesses per code. Every send costs
  money and rings a real phone, so loosen these carefully.
- **The society list.** Sourced live from `master_societies WHERE active`
  (1,158 societies today) and cached at the edge for an hour. Activate a
  society in the Properties DB and the form offers it within the hour — no
  redeploy. If that DB is unreachable the field accepts free text rather than
  blocking the form, so leads still come through.
- **Changing city.** Societies are scoped to the chosen city, so going back
  and switching city clears any society already picked.
- **Duplicate submissions.** The same phone number can submit more than once;
  there is an index on `phone` but no unique constraint, because a genuine
  second listing is a real case. De-duplicate when reading, not on write.
