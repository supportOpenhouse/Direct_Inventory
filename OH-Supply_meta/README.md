# OH Supply — Meta lead-ad landing page

A standalone, single-page lead capture form for Meta (Facebook/Instagram) lead
ads. It is deployed **separately** from the main app but writes to the **same
Postgres database**, into its own table: `meta_ads_responses`.

```
public/index.html   the 8-step form (plain HTML/CSS/JS, no build step)
api/lead.js         POST /api/lead      — validates and inserts into Postgres
api/societies.js    GET  /api/societies — the societies we cover, cached
schema.sql          the meta_ads_responses table (idempotent)
vercel.json         security headers; no framework build
```

## Two databases

This page talks to both of the main app's databases, in opposite directions:

| Env var             | Direction  | Used for                                    |
| ------------------- | ---------- | ------------------------------------------- |
| `DATABASE_URL`      | write      | inserting leads into `meta_ads_responses`   |
| `PROPERTIES_DB_URL` | read-only  | `master_societies` for the society dropdown |

Both values are the same ones already in `backend/.env`.

## How it works

1. Someone taps the ad and lands on `/` with Meta's tracking params in the URL
   (`fbclid`, `utm_*`, `campaign_id`, …).
2. Those params are read **once on page load** and held in memory — by submit
   time a stray navigation could have cleared them.
3. On load the page also fetches `/api/societies` and builds the step-6
   autocomplete from it, filtered to the city picked in step 4.
4. On submit the page POSTs JSON to `/api/lead`, a Vercel serverless function
   on the same origin (so there is no CORS to configure).
5. The function validates, normalises the phone to `+91XXXXXXXXXX`, inserts one
   row, and returns a reference like `OH00042` that the thank-you screen shows.

If the insert fails the form stays on screen with an error message, so nothing
the person typed is lost.

## Database

The table already exists in the shared database. It was created from
`schema.sql`, which is idempotent — re-running it is safe and changes nothing.

```bash
psql "$DATABASE_URL" -f schema.sql
```

Nothing else in the database is read or written by this project.

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
4. **Environment Variables** → add **both** `DATABASE_URL` and
   `PROPERTIES_DB_URL`, the same values as in `backend/.env`, for Production
   (and Preview, if you want previews to work too). Without
   `PROPERTIES_DB_URL` the society dropdown falls back to free text.
5. Deploy.

### Via the CLI

```bash
cd OH-Supply_meta
vercel link                       # create/select a NEW project, not the main one
vercel env add DATABASE_URL production
vercel env add PROPERTIES_DB_URL production
vercel --prod
```

### After deploying

Point the Meta ad's destination URL at the deployment, keeping the tracking
params Meta appends. Then submit one real test lead and confirm it lands:

```sql
SELECT * FROM meta_ads_responses ORDER BY id DESC LIMIT 1;
```

## Local development

```bash
npm install
cp .env.example .env.local    # paste the real DATABASE_URL + PROPERTIES_DB_URL
vercel dev                    # serves the page and /api/lead together
```

`vercel dev` is what you want rather than opening `index.html` directly — the
page posts to a same-origin `/api/lead`, which only exists under the dev server.

## Notes

- **Connection footprint.** Each warm function instance holds at most one
  pooled connection (`max: 1`) and drops it after 10s idle, so a traffic spike
  can't exhaust either database's connection limit and starve the main app.
  Use Neon's pooler endpoint (`-pooler` in the host name) for both URLs.
- **Personal data.** The form records name, phone, email and an explicit
  consent flag. IP address and user agent are deliberately *not* stored. Keep
  that in mind before adding them.
- **The society list.** Sourced live from `master_societies WHERE active`
  (1,158 societies today) and cached at the edge for an hour. Activate a
  society in the Properties DB and the form offers it within the hour — no
  redeploy. If that DB is unreachable the field accepts free text rather than
  blocking the form, so leads still come through.
- **Changing city.** Societies are scoped to the city chosen in step 4, so
  going back and switching city clears any society already picked.
- **Duplicate submissions.** The same phone number can submit more than once;
  there is an index on `phone` but no unique constraint, because a genuine
  second listing is a real case. De-duplicate when reading, not on write.
