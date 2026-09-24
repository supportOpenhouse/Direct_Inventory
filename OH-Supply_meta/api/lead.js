/**
 * POST /api/lead — persist one landing-page submission to meta_ads_responses.
 *
 * Runs as a Vercel Node serverless function against the same Postgres as the
 * main app (DATABASE_URL). This is the only writer to that table.
 *
 * The phone number must carry a verified, unconsumed OTP. The browser also
 * sends phone_verified, but that is ignored: anyone can POST here directly, so
 * trusting a client flag would make the whole OTP step decorative.
 */
import { getPool, jsonBody, normalisePhone, rejectNonMethod, str } from "./_lib.js";

/** Client-sent ISO timestamp, or null if it isn't a real date. */
function isoOrNull(value) {
  const raw = str(value, 64);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Claim the newest verified, unconsumed, unexpired OTP for this phone.
// The UPDATE ... RETURNING is atomic: two simultaneous submissions race for
// the same row and exactly one wins, so one verification can't yield two leads.
const CLAIM_OTP = `
  UPDATE meta_otp_verifications
     SET consumed_at = now()
   WHERE id = (
     SELECT id FROM meta_otp_verifications
      WHERE phone = $1
        AND verified_at IS NOT NULL
        AND consumed_at IS NULL
        AND expires_at > now()
      ORDER BY verified_at DESC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
  RETURNING id
`;

const INSERT = `
  INSERT INTO meta_ads_responses (
    name, phone, email, city, configuration, society,
    expected_price_lacs, consent, source, submitted_at, phone_verified,
    fbclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    ad_id, adset_id, campaign_id, landing_url
  ) VALUES (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9, $10, TRUE,
    $11, $12, $13, $14, $15, $16,
    $17, $18, $19, $20
  )
  RETURNING id, created_at
`;

export default async function handler(req, res) {
  if (rejectNonMethod(req, res, "POST")) return;

  const body = jsonBody(req);
  if (!body) return res.status(400).json({ ok: false, error: "invalid_body" });

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

  const attribution =
    body.attribution && typeof body.attribution === "object" ? body.attribution : {};

  const pool = getPool("DATABASE_URL");
  const client = await pool.connect();

  try {
    // Claim and insert together: if the insert fails, the OTP is released
    // rather than burnt, so the person can retry without a new code.
    await client.query("BEGIN");

    const { rows: claimed } = await client.query(CLAIM_OTP, [phone]);
    if (!claimed.length) {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, error: "phone_not_verified" });
    }

    const { rows } = await client.query(INSERT, [
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
    ]);

    await client.query("COMMIT");

    const row = rows[0];
    return res.status(201).json({
      ok: true,
      id: row.id,
      // Short, human-readable reference shown on the thank-you screen.
      ref: `OH${String(row.id).padStart(5, "0")}`,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection already gone */
    }
    // Never leak DSN/driver detail to the browser; the detail goes to logs.
    console.error("meta_ads_responses insert failed:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
}
