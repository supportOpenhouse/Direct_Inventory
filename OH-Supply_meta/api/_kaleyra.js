/**
 * Kaleyra SMS — sending the OTP.
 *
 * India region, so the domain is api.in.kaleyra.io and the path carries the
 * account SID: POST /v1/<SID>/messages with an `api-key` header.
 *
 * The body must match the DLT-registered template exactly (KALEYRA_OTP_BODY,
 * with {otp} substituted) — Indian carriers reject anything that doesn't,
 * which is why the text is configuration rather than a string in this file.
 */
const API_BASE = process.env.KALEYRA_API_BASE || "https://api.in.kaleyra.io";

/** True when every credential needed to actually send is present. */
export function kaleyraConfigured() {
  return Boolean(
    process.env.KALEYRA_API_KEY &&
      process.env.KALEYRA_ACCOUNT_ID &&
      process.env.KALEYRA_SMS_SENDER &&
      process.env.KALEYRA_OTP_BODY
  );
}

/**
 * Send `code` to `phone` (E.164). Resolves on success, throws otherwise.
 * The caller decides what the browser is told — never surface this detail.
 */
export async function sendOtpSms(phone, code) {
  const apiKey = process.env.KALEYRA_API_KEY;
  const sid = process.env.KALEYRA_ACCOUNT_ID;
  const sender = process.env.KALEYRA_SMS_SENDER;
  const templateId = process.env.KALEYRA_OTP_TEMPLATE_ID;
  const bodyTemplate = process.env.KALEYRA_OTP_BODY;

  if (!kaleyraConfigured()) throw new Error("kaleyra_not_configured");

  const payload = {
    to: phone,
    sender,
    // Transactional. OTPs must not go out as marketing traffic: MKT is subject
    // to DND filtering and would silently not arrive for many numbers.
    type: "TXN",
    body: bodyTemplate.replace(/\{otp\}/g, code),
  };
  if (templateId) payload.template_id = templateId;

  // Don't let a hanging SMS call hold the function open to its timeout.
  const abort = AbortSignal.timeout(10_000);

  const res = await fetch(`${API_BASE}/v1/${encodeURIComponent(sid)}/messages`, {
    method: "POST",
    headers: { "api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: abort,
  });

  const text = await res.text();
  if (!res.ok) {
    // Response bodies echo the message text; log the status and a short
    // excerpt only, so the OTP itself never lands in the logs.
    throw new Error(`kaleyra_http_${res.status}: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}
