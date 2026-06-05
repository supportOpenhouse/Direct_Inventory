"""Geo data for the My Profile coverage map.

Serves society coordinates from the bundled JSON so the map can plot exact
markers with no geocoding API. Each entry is {name, city, lat, lng}; the
frontend keys by name|city (with a name-only fallback) so same-named societies
in different cities don't collide.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.parse
import urllib.request

from flask import Blueprint, jsonify, request

from ..db import get_props_conn
from .auth import require_auth

bp = Blueprint("geo", __name__, url_prefix="/api/geo")
log = logging.getLogger(__name__)

# City boundary polygons, fetched once from OpenStreetMap (Nominatim, keyless)
# and cached for the worker's lifetime. Used to shade/outline the user's scope
# city on the profile map.
_city_cache: dict[str, dict] = {}

# Cities whose boundary the name search misses — pin them to a known OSM relation
# id (looked up directly). Keyed by lower-cased city name.
_CITY_OSM_RELATION = {
    "ghaziabad": 9999582,
}


@bp.get("/city-boundary")
@require_auth()
def city_boundary():
    """GeoJSON boundary polygon for a city (India). { city, geometry }."""
    city = (request.args.get("city") or "").strip()
    if not city:
        return jsonify({"error": "city required"}), 400
    key = city.lower()
    if key in _city_cache:
        return jsonify(_city_cache[key])
    out = {"city": city, "geometry": None}

    def _fetch_polygon(endpoint, params):
        url = f"https://nominatim.openstreetmap.org/{endpoint}?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": "DirectInventory/1.0 (support@openhouse.in)"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        for d in data or []:
            g = d.get("geojson")
            if g and g.get("type") in ("Polygon", "MultiPolygon"):
                return g
        return None

    try:
        rel = _CITY_OSM_RELATION.get(key)
        if rel:
            # Pinned relation id (e.g. Ghaziabad R9999582) — look it up directly.
            geom = _fetch_polygon("lookup", {"osm_ids": f"R{rel}", "format": "jsonv2", "polygon_geojson": 1})
        else:
            # Structured city= first; fall back to free-text q=. Some cities have
            # no admin polygon in OSM at all — those simply won't shade.
            geom = _fetch_polygon("search", {"city": city, "country": "India", "format": "jsonv2", "polygon_geojson": 1, "limit": 10})
            if not geom:
                geom = _fetch_polygon("search", {"q": f"{city}, India", "format": "jsonv2", "polygon_geojson": 1, "limit": 10})
        out["geometry"] = geom
    except Exception as e:  # network/provider issue — non-fatal, no shading
        log.warning("city-boundary fetch failed for %r: %s", city, e)
        out["error"] = str(e)
    _city_cache[key] = out
    return jsonify(out)

_SOC_COORDS: list | None = None
_SOC_COORDS_PATH = os.path.join(os.path.dirname(__file__), "..", "migrations", "socities_coords.json")


def _load_society_coords() -> list:
    global _SOC_COORDS
    if _SOC_COORDS is not None:
        return _SOC_COORDS
    out: list = []
    try:
        with open(_SOC_COORDS_PATH, encoding="utf-8") as fh:
            for r in json.load(fh):
                name = (r.get("society_name") or "").strip()
                lat, lng = r.get("latitude"), r.get("longitude")
                if name and lat is not None and lng is not None:
                    out.append({"name": name, "city": (r.get("city") or None), "lat": lat, "lng": lng})
    except Exception as e:  # missing/bad file — map just won't have pins
        log.warning("society coords load failed (%s): %s", _SOC_COORDS_PATH, e)

    # Surface duplicate names that lack a city — those collide in the name-only
    # fallback (one silently wins). Add a "city" to each so name|city resolves.
    by_name: dict[str, list] = {}
    for e in out:
        by_name.setdefault(e["name"].strip().lower(), []).append(e)
    unresolved = [n for n, es in by_name.items() if len(es) > 1 and any(not e["city"] for e in es)]
    if unresolved:
        log.warning(
            "society coords: %d duplicate name(s) without a city (will collide): %s",
            len(unresolved), ", ".join(sorted(unresolved)),
        )

    _SOC_COORDS = out
    return out


@bp.get("/society-coords")
@require_auth()
def society_coords():
    """Society coordinates for the profile coverage map: [{name, city, lat, lng}]."""
    items = _load_society_coords()
    return jsonify({"items": items, "count": len(items)})


# Extracted micro-market coordinates — same approach as societies: a bundled
# JSON of name → lat/lng (+ optional city), so we plot exact dots instead of
# deriving a centroid from society coords. Drop the file in and restart; if it's
# absent the endpoint falls back to the derived computation below.
_MM_COORDS_PATH = os.path.join(os.path.dirname(__file__), "..", "migrations", "micromarket_coords.json")
_MM_COORDS: list | None = None


def _load_micromarket_coords() -> list:
    global _MM_COORDS
    if _MM_COORDS is not None:
        return _MM_COORDS
    out: list = []
    try:
        with open(_MM_COORDS_PATH, encoding="utf-8") as fh:
            for r in json.load(fh):
                name = (r.get("micro_market") or r.get("name") or "").strip()
                lat, lng = r.get("latitude"), r.get("longitude")
                if name and lat is not None and lng is not None:
                    out.append({
                        "name": name,
                        "city": (r.get("city") or None),
                        "center": [lat, lng],
                        "geometry": None,
                        "count": 1,
                    })
    except FileNotFoundError:
        pass  # no extracted file → caller falls back to the derived computation
    except Exception as e:
        log.warning("micro-market coords load failed (%s): %s", _MM_COORDS_PATH, e)
    _MM_COORDS = out
    return out


def _convex_hull(latlng_points):
    """Andrew's monotone chain. In/out are (lat, lng) tuples; computed on (lng,lat)."""
    pts = sorted(set((lng, lat) for (lat, lng) in latlng_points))
    if len(pts) <= 2:
        return [(lat, lng) for (lng, lat) in pts]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    return [(lat, lng) for (lng, lat) in hull]


# Micro-market geometry, derived once from society coords + master_societies and
# cached: each micro-market's centre (dot) and convex hull (border).
_MM_CACHE: list | None = None


@bp.get("/micro-markets")
@require_auth()
def micro_markets():
    """Per micro-market: { name, center: [lat,lng], geometry: Polygon|null, count }.

    Prefers extracted micro-market coords from the bundled micromarket_coords.json
    (exact dots, no processing — same as societies). If that file is absent, falls
    back to deriving each centre from the mean of its societies' coords (joined to
    PROPERTIES_DB.master_societies) with a convex-hull geometry.
    """
    global _MM_CACHE
    if _MM_CACHE is not None:
        return jsonify({"items": _MM_CACHE})

    # Preferred: exact extracted coordinates.
    extracted = _load_micromarket_coords()
    if extracted:
        _MM_CACHE = extracted
        return jsonify({"items": extracted})

    # Fallback: derive from society coords + master_societies.
    by_name: dict[str, list] = {}
    for c in _load_society_coords():
        by_name.setdefault(c["name"].strip().lower(), []).append((c["lat"], c["lng"]))

    groups: dict[str, list] = {}
    try:
        conn = get_props_conn()
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT society_name, micro_market FROM master_societies "
                "WHERE micro_market IS NOT NULL AND micro_market <> '' AND society_name IS NOT NULL"
            )
            rows = cur.fetchall()
        conn.close()
    except Exception as e:
        log.warning("micro-markets: master_societies read failed: %s", e)
        return jsonify({"items": [], "error": str(e)})

    for r in rows:
        mm = (r["micro_market"] or "").strip()
        sname = (r["society_name"] or "").strip().lower()
        pts = by_name.get(sname)
        if mm and pts:
            groups.setdefault(mm, []).extend(pts)

    items = []
    for mm, pts in groups.items():
        lat = sum(p[0] for p in pts) / len(pts)
        lng = sum(p[1] for p in pts) / len(pts)
        geometry = None
        hull = _convex_hull(pts)
        if len(hull) >= 3:
            ring = [[ln, la] for (la, ln) in hull]
            ring.append(ring[0])
            geometry = {"type": "Polygon", "coordinates": [ring]}
        items.append({"name": mm, "center": [lat, lng], "geometry": geometry, "count": len(pts)})

    _MM_CACHE = items
    return jsonify({"items": items})
