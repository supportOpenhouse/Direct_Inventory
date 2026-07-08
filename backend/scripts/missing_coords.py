"""Report societies / micro-markets present in PROPERTIES_DB.master_societies
but missing from the bundled coord JSONs. Read-only. Run: python -m backend.scripts.missing_coords"""
import json, os, psycopg2
from psycopg2.extras import RealDictCursor
from backend import config

HERE = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(HERE, "..", "migrations")


def json_names(path, key):
    with open(path) as f:
        return {(r.get(key) or "").strip() for r in json.load(f)} - {""}


def main():
    if not config.PROPERTIES_DB_URL:
        raise SystemExit("PROPERTIES_DB_URL is not set")

    have_soc = json_names(os.path.join(MIG, "socities_coords.json"), "society_name")
    have_mm = json_names(os.path.join(MIG, "micromarket_coords.json"), "micro_market")

    conn = psycopg2.connect(config.PROPERTIES_DB_URL)
    conn.set_session(readonly=True)
    with conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT DISTINCT society_name FROM master_societies "
                    "WHERE society_name IS NOT NULL AND society_name <> ''")
        db_soc = {r["society_name"].strip() for r in cur.fetchall()}
        cur.execute("SELECT DISTINCT micro_market FROM master_societies "
                    "WHERE micro_market IS NOT NULL AND micro_market <> ''")
        db_mm = {r["micro_market"].strip() for r in cur.fetchall()}
    conn.close()

    missing_soc = sorted(db_soc - have_soc)
    missing_mm = sorted(db_mm - have_mm)

    print(f"\n=== SOCIETIES missing from socities_coords.json: {len(missing_soc)} "
          f"(of {len(db_soc)} in DB, {len(have_soc)} in JSON) ===")
    for n in missing_soc:
        print(n)
    print(f"\n=== MICRO-MARKETS missing from micromarket_coords.json: {len(missing_mm)} "
          f"(of {len(db_mm)} in DB, {len(have_mm)} in JSON) ===")
    for n in missing_mm:
        print(n)


if __name__ == "__main__":
    main()
