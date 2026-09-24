/**
 * Shared helpers for the lead-capture functions.
 *
 * Each serverless instance keeps one pooled connection per database and drops
 * it after 10s idle, so a traffic spike can't exhaust the connection limit and
 * starve the main app.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";

const pools = new Map();

/** Lazily-created pool for the database behind `envVar`. */
export function getPool(envVar) {
  let pool = pools.get(envVar);
  if (!pool) {
    const connectionString = process.env[envVar];
    if (!connectionString) throw new Error(`${envVar} is not set`);
    // TLS comes from the DSN's own sslmode; passing `ssl` too makes pg warn
    // about conflicting settings.
    //
    // max is 2, not 1: /api/lead checks out a client for a transaction, and a
    // single-connection pool would make any concurrent query on the same warm
    // instance wait for that transaction to finish.
    pool = new Pool({
      connectionString,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    pools.set(envVar, pool);
  }
  return pool;
}

/** Trim to a string, or null for anything empty/absent. */
export function str(value, maxLength = 512) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

/** Digits-only Indian mobile, normalised to +91XXXXXXXXXX. Null if unusable. */
export function normalisePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (local.length !== 10 || !/^[6-9]/.test(local)) return null;
  return `+91${local}`;
}

/** A cryptographically random 6-digit code, leading zeros kept. */
export function generateOtp() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * sha256(code + phone). Salting with the phone means one stolen hash can't be
 * matched against a precomputed table of all 10^6 six-digit codes.
 */
export function hashOtp(code, phone) {
  return createHash("sha256").update(`${code}:${phone}`).digest("hex");
}

/** Constant-time hash comparison, so timing can't leak the code. */
export function hashesMatch(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Caller IP. Vercel sets x-forwarded-for; the client-controlled part is
 * appended, so the FIRST entry is the real caller.
 */
export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return str(req.headers["x-real-ip"], 64);
}

/** Parse a JSON body, tolerating a raw string. Returns null if unusable. */
export function jsonBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body && typeof body === "object" ? body : null;
}

/** Reject anything but `method`, returning true if the request was handled. */
export function rejectNonMethod(req, res, method) {
  if (req.method === method) return false;
  res.setHeader("Allow", method);
  res.status(405).json({ ok: false, error: "method_not_allowed" });
  return true;
}
