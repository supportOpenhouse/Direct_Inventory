/**
 * End-to-end test of the OTP gate against a real database.
 *
 * The Kaleyra HTTP call is stubbed, so no SMS is sent and no credit is spent,
 * but everything else — the tables, the transaction, the rate limits — is the
 * real thing. Test rows are cleaned up on the way out.
 *
 * Run from the repo root with DATABASE_URL set:
 *     node OH-Supply_meta/test/otp-flow.mjs
 */
process.env.KALEYRA_API_KEY ||= "test";
process.env.KALEYRA_ACCOUNT_ID ||= "test";
process.env.KALEYRA_SMS_SENDER ||= "OHAVAN";
process.env.KALEYRA_OTP_BODY ||=
  "Your OTP for login is {otp}. Avano Technologies Pvt Ltd.";

let sentBody = null, sentCode = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("kaleyra")) {
    sentBody = JSON.parse(opts.body);
    sentCode = sentBody.body.match(/\b(\d{6})\b/)[1];
    return new Response(JSON.stringify({ id: "stub" }), { status: 200 });
  }
  return realFetch(url, opts);
};

const here = new URL(".", import.meta.url).pathname;
const send = (await import(`${here}../api/otp/send.js`)).default;
const verify = (await import(`${here}../api/otp/verify.js`)).default;
const lead = (await import(`${here}../api/lead.js`)).default;
const { getPool } = await import(`${here}../api/_lib.js`);

const mkRes = () => {
  const r = {};
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = () => {};
  return r;
};
const call = async (h, body, headers = {}) => {
  const r = mkRes();
  await h({ method: "POST", body, headers }, r);
  return r;
};

const PHONE = "+919876500011";
let pass = 0, fail = 0;
const t = (label, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${extra ? "  " + extra : ""}`);
};

const pool = getPool("DATABASE_URL");
const wipe = async () => {
  await pool.query("DELETE FROM meta_otp_verifications WHERE phone=$1", [PHONE]);
  await pool.query("DELETE FROM meta_ads_responses WHERE phone=$1", [PHONE]);
};
const leadBody = () => ({
  name: "CLAUDE OTP TEST", phone: PHONE, city: "Noida", configuration: "3 BHK",
  society: "3C Lotus 300", expected_price_lacs: "90", consent: true,
  attribution: { utm_source: "facebook" },
});

await wipe();
try {
  let r = await call(lead, leadBody());
  t("lead blocked with no OTP", r.code === 403 && r.body.error === "phone_not_verified");

  r = await call(send, { phone: PHONE });
  t("send ok", r.code === 200 && r.body.ok === true);
  t("SMS body matches DLT template",
    sentBody.body === `Your OTP for login is ${sentCode}. Avano Technologies Pvt Ltd.`);
  t("SMS type is transactional", sentBody.type === "TXN");
  t("code is 6 digits", /^\d{6}$/.test(sentCode));

  const { rows: stored } = await pool.query(
    "SELECT code_hash FROM meta_otp_verifications WHERE phone=$1", [PHONE]);
  t("code stored hashed only",
    !stored.some((x) => x.code_hash.includes(sentCode)) && stored[0].code_hash.length === 64);

  const wrong = sentCode === "000000" ? "111111" : "000000";
  r = await call(verify, { phone: PHONE, code: wrong });
  t("wrong code rejected", r.code === 400 && r.body.error === "incorrect_code");
  t("attempts_left reported", r.body.attempts_left === 4);

  r = await call(verify, { phone: PHONE, code: sentCode });
  t("correct code verifies", r.code === 200 && r.body.ok === true);

  r = await call(verify, { phone: PHONE, code: sentCode });
  t("re-verify still ok", r.code === 200 && r.body.ok === true);

  r = await call(lead, leadBody());
  t("lead accepted after verify", r.code === 201 && r.body.ok === true);

  r = await call(lead, leadBody());
  t("OTP is one-shot (no replay)", r.code === 403 && r.body.error === "phone_not_verified");

  const { rows: lr } = await pool.query(
    "SELECT phone_verified, utm_source FROM meta_ads_responses WHERE phone=$1", [PHONE]);
  t("phone_verified stored true", lr[0].phone_verified === true);
  t("attribution stored", lr[0].utm_source === "facebook");

  await pool.query("DELETE FROM meta_ads_responses WHERE phone=$1", [PHONE]);
  r = await call(lead, { ...leadBody(), phone_verified: true });
  t("client phone_verified flag ignored", r.code === 403);

  r = await call(send, { phone: PHONE });
  t("resend within 30s throttled", r.code === 429 && r.body.error === "too_soon");

  r = await call(send, { phone: "12345" });
  t("invalid phone rejected", r.code === 400 && r.body.error === "invalid_phone");

  await pool.query(
    `UPDATE meta_otp_verifications
        SET expires_at = now() - interval '1 min', consumed_at = NULL, verified_at = NULL
      WHERE phone = $1`, [PHONE]);
  r = await call(verify, { phone: PHONE, code: sentCode });
  t("expired code rejected", r.code === 400 && r.body.error === "otp_expired");
} finally {
  await wipe();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
