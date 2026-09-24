/**
 * GET /api/societies — the societies Openhouse covers, grouped by city.
 *
 * Reads master_societies from the acquisition Properties DB, which is a
 * DIFFERENT database from the one leads are written to. Read-only, always:
 * this endpoint must never write there.
 *
 * The result is ~24 KB and changes rarely, so it is cached at the Vercel edge
 * for an hour and served stale for a day while revalidating. A society added
 * in the DB shows up in the form within the hour with no redeploy.
 */
import { getPool, rejectNonMethod } from "./_lib.js";

// DISTINCT because a society can appear more than once per city in the master
// list; ordering by name keeps the suggestion list alphabetical for free.
const QUERY = `
  SELECT DISTINCT
         trim(city)         AS city,
         trim(society_name) AS society_name,
         trim(coalesce(locality, '')) AS locality
    FROM master_societies
   WHERE active IS TRUE
     AND society_name IS NOT NULL AND trim(society_name) <> ''
     AND city         IS NOT NULL AND trim(city)         <> ''
   ORDER BY society_name
`;

// Served when the Properties DB is unreachable, so a transient outage degrades
// to "type anything" rather than a form nobody can get past.
const EMPTY = { ok: false, cities: {} };

export default async function handler(req, res) {
  if (rejectNonMethod(req, res, "GET")) return;

  try {
    const { rows } = await getPool("PROPERTIES_DB_URL").query(QUERY);

    // { "Gurgaon": [{ n: "DLF Regal Gardens", l: "Sector 90" }, ...], ... }
    // Short keys because this payload is downloaded by every visitor on a
    // phone, often on mobile data.
    const cities = {};
    for (const row of rows) {
      (cities[row.city] ||= []).push(
        row.locality ? { n: row.society_name, l: row.locality } : { n: row.society_name }
      );
    }

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=86400"
    );
    return res.status(200).json({ ok: true, cities });
  } catch (err) {
    console.error("master_societies read failed:", err);
    // Don't let a failure get cached as though it were the real list.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(EMPTY);
  }
}
