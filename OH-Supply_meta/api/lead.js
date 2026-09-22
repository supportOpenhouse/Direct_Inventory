/**
 * POST /api/lead — persist one landing-page submission to meta_ads_responses.
 *
 * Runs as a Vercel Node serverless function against the same Postgres as the
 * main app (DATABASE_URL). This is the only writer to that table.
 *
 * Serverless functions are recycled constantly, so the pool is module-scoped
 * and kept tiny: each warm instance holds at most one connection, and idle
 * ones are dropped quickly so suspended-compute sockets aren't reused.
 */
import { Pool } from "pg";

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      // TLS comes from the DSN's own sslmode (Neon requires it). Passing an
      // `ssl` object here as well makes pg warn about conflicting settings,
      // so leave the connection string in charge.
    });
  }
  return pool;
}

/** Trim to a string, or null for anything empty/absent. */
function str(value, maxLength = 512) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

/** Digits-only Indian mobile, normalised to +91XXXXXXXXXX. Null if unusable. */
function normalisePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (local.length !== 10 || !/^[6-9]/.test(local)) return null;
  return `+91${local}`;
}

/** Client-sent ISO timestamp, or null if it isn't a real date. */
function isoOrNull(value) {
  const raw = str(value, 64);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const INSERT = `
  INSERT INTO meta_ads_responses (
    name, phone, email, city, configuration, society,
    expected_price_lacs, consent, source, submitted_at,
    fbclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    ad_id, adset_id, campaign_id, landing_url
  ) VALUES (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16,
    $17, $18, $19, $20
  )
  RETURNING id, created_at
`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  // Vercel parses JSON bodies for us; tolerate a raw string just in case.
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false, error: "invalid_json" });
    }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ ok: false, error: "invalid_body" });
  }

  const name = str(body.name, 200);
  const phone = normalisePhone(body.phone);
  const city = str(body.city, 100);
  const configuration = str(body.configuration, 50);
  const society = str(body.society, 300);

  const missing = [];
  if (!name) missing.push("name");
  if (!phone) missing.push("phone");
  if (!city) missing.push("city");
  if (!configuration) missing.push("configuration");
  if (!society) missing.push("society");
  if (missing.length) {
    return res.status(400).json({ ok: false, error: "missing_fields", fields: missing });
  }

  const priceRaw = Number.parseFloat(body.expected_price_lacs);
  const price = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null;

  const attribution = body.attribution && typeof body.attribution === "object" ? body.attribution : {};

  const values = [
    name,
    phone,
    str(body.email, 320),
    city,
    configuration,
    society,
    price,
    Boolean(body.consent),
    str(body.source, 60) ?? "meta_lead_ad",
    isoOrNull(body.submitted_at),
    str(attribution.fbclid, 512),
    str(attribution.utm_source, 200),
    str(attribution.utm_medium, 200),
    str(attribution.utm_campaign, 200),
    str(attribution.utm_content, 200),
    str(attribution.utm_term, 200),
    str(attribution.ad_id, 100),
    str(attribution.adset_id, 100),
    str(attribution.campaign_id, 100),
    str(attribution.landing_url, 2048),
  ];

  try {
    const { rows } = await getPool().query(INSERT, values);
    const row = rows[0];
    return res.status(201).json({
      ok: true,
      id: row.id,
      // Short, human-readable reference shown on the thank-you screen.
      ref: `OH${String(row.id).padStart(5, "0")}`,
    });
  } catch (err) {
    // Never leak DSN/driver detail to the browser; the detail goes to logs.
    console.error("meta_ads_responses insert failed:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
