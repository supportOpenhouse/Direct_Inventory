/**
 * POST /api/otp/send — generate a 6-digit code, SMS it, store its hash.
 *
 * Every send costs real money and rings a real phone, so this endpoint is
 * rate limited on both the number and the caller IP. Without that, the form
 * is a free SMS-bombing tool pointed at whatever number the attacker types.
 */
import {
  clientIp,
  generateOtp,
  getPool,
  hashOtp,
  jsonBody,
  normalisePhone,
  rejectNonMethod,
} from "../_lib.js";
import { kaleyraConfigured, sendOtpSms } from "../_kaleyra.js";

const OTP_TTL_MINUTES = 10;
const MAX_PER_PHONE_PER_HOUR = 5;
const MAX_PER_IP_PER_HOUR = 15;
// A resend that lands seconds after the first would arrive out of order and
// invalidate the code the person is already typing.
const MIN_SECONDS_BETWEEN_SENDS = 30;

const RECENT_COUNTS = `
  SELECT
    count(*) FILTER (WHERE phone = $1 AND created_at > now() - interval '1 hour')           AS phone_hour,
    count(*) FILTER (WHERE $2::text IS NOT NULL AND ip = $2 AND created_at > now() - interval '1 hour') AS ip_hour,
    max(created_at) FILTER (WHERE phone = $1)                                               AS last_sent
  FROM meta_otp_verifications
`;

const INSERT = `
  INSERT INTO meta_otp_verifications (phone, code_hash, expires_at, ip)
  VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4)
  RETURNING id
`;

export default async function handler(req, res) {
  if (rejectNonMethod(req, res, "POST")) return;

  const body = jsonBody(req);
  if (!body) return res.status(400).json({ ok: false, error: "invalid_body" });

  const phone = normalisePhone(body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: "invalid_phone" });

  if (!kaleyraConfigured()) {
    console.error("OTP send attempted but Kaleyra is not configured");
    return res.status(503).json({ ok: false, error: "otp_unavailable" });
  }

  const ip = clientIp(req);
  const pool = getPool("DATABASE_URL");

  try {
    const { rows } = await pool.query(RECENT_COUNTS, [phone, ip]);
    const { phone_hour: phoneHour, ip_hour: ipHour, last_sent: lastSent } = rows[0];

    if (lastSent) {
      const sinceLast = (Date.now() - new Date(lastSent).getTime()) / 1000;
      if (sinceLast < MIN_SECONDS_BETWEEN_SENDS) {
        return res.status(429).json({
          ok: false,
          error: "too_soon",
          retry_after: Math.ceil(MIN_SECONDS_BETWEEN_SENDS - sinceLast),
        });
      }
    }
    if (Number(phoneHour) >= MAX_PER_PHONE_PER_HOUR) {
      return res.status(429).json({ ok: false, error: "too_many_requests" });
    }
    if (ip && Number(ipHour) >= MAX_PER_IP_PER_HOUR) {
      return res.status(429).json({ ok: false, error: "too_many_requests" });
    }

    const code = generateOtp();

    // Send BEFORE storing: if the SMS fails there is no row, so the failed
    // attempt doesn't count against the person's hourly limit.
    await sendOtpSms(phone, code);

    await pool.query(INSERT, [phone, hashOtp(code, phone), String(OTP_TTL_MINUTES), ip]);

    return res.status(200).json({
      ok: true,
      expires_in: OTP_TTL_MINUTES * 60,
      resend_after: MIN_SECONDS_BETWEEN_SENDS,
    });
  } catch (err) {
    console.error("OTP send failed:", err);
    return res.status(502).json({ ok: false, error: "send_failed" });
  }
}
