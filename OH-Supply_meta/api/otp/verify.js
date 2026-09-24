/**
 * POST /api/otp/verify — check a code against the newest OTP for that phone.
 *
 * Verifying only marks the row verified. The lead endpoint is what consumes
 * it, so a verification can't be replayed into several leads.
 */
import {
  getPool,
  hashOtp,
  hashesMatch,
  jsonBody,
  normalisePhone,
  rejectNonMethod,
  str,
} from "../_lib.js";

const MAX_ATTEMPTS = 5;

// Newest OTP for this phone, whatever its state — an expired or exhausted row
// must produce its own error rather than looking like "no code was sent".
const LATEST = `
  SELECT id, code_hash, attempts, verified_at, consumed_at,
         (expires_at < now()) AS expired
    FROM meta_otp_verifications
   WHERE phone = $1
   ORDER BY created_at DESC
   LIMIT 1
`;

export default async function handler(req, res) {
  if (rejectNonMethod(req, res, "POST")) return;

  const body = jsonBody(req);
  if (!body) return res.status(400).json({ ok: false, error: "invalid_body" });

  const phone = normalisePhone(body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: "invalid_phone" });

  const code = (str(body.code, 10) || "").replace(/\D/g, "");
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: "invalid_code_format" });
  }

  const pool = getPool("DATABASE_URL");

  try {
    const { rows } = await pool.query(LATEST, [phone]);
    const row = rows[0];

    if (!row) return res.status(400).json({ ok: false, error: "no_otp_sent" });
    if (row.consumed_at) return res.status(400).json({ ok: false, error: "already_used" });
    if (row.expired) return res.status(400).json({ ok: false, error: "otp_expired" });
    if (row.attempts >= MAX_ATTEMPTS) {
      return res.status(429).json({ ok: false, error: "too_many_attempts" });
    }

    // Already verified and not yet consumed — let the person move on rather
    // than fail a double-submit of the same correct code.
    if (row.verified_at && hashesMatch(row.code_hash, hashOtp(code, phone))) {
      return res.status(200).json({ ok: true, verified: true });
    }

    if (!hashesMatch(row.code_hash, hashOtp(code, phone))) {
      // Count the wrong guess, and report what's left so the UI can warn.
      const { rows: bumped } = await pool.query(
        "UPDATE meta_otp_verifications SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts",
        [row.id]
      );
      const attempts = bumped[0]?.attempts ?? row.attempts + 1;
      return res.status(400).json({
        ok: false,
        error: "incorrect_code",
        attempts_left: Math.max(0, MAX_ATTEMPTS - attempts),
      });
    }

    await pool.query(
      "UPDATE meta_otp_verifications SET verified_at = now() WHERE id = $1",
      [row.id]
    );
    return res.status(200).json({ ok: true, verified: true });
  } catch (err) {
    console.error("OTP verify failed:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
