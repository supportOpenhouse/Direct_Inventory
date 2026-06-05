import { api } from '../api/client.js';
import { displayCity } from './format.js';

// Society coordinate lookups, fetched once and cached in-module:
//   byNameCity: "name|city" -> [lat, lng]   (city folded: Greater Noida → Noida)
//   byName:     "name"      -> [lat, lng]   (fallback; last one wins on dupes)
let _data = null;
let _inflight = null;

const norm = (s) => (s || '').trim().toLowerCase();
const normCity = (c) => norm(displayCity(c));

export async function societyCoords() {
  if (_data) return _data;
  if (!_inflight) {
    _inflight = api.get('/api/geo/society-coords')
      .then((r) => {
        const items = r.items || [];
        const byNameCity = {};
        const byName = {};
        for (const it of items) {
          const n = norm(it.name);
          if (!n) continue;
          const pt = [it.lat, it.lng];
          byName[n] = pt;
          if (it.city) byNameCity[`${n}|${normCity(it.city)}`] = pt;
        }
        _data = { byNameCity, byName, items };
        return _data;
      })
      .catch(() => { _data = { byNameCity: {}, byName: {}, items: [] }; return _data; });
  }
  return _inflight;
}

// Resolve a society's coords. Tries name|city for each of the user's cities
// (disambiguates same-named societies across cities), then falls back to name.
export function lookupCoord(data, name, cities = []) {
  if (!data || !name) return null;
  const n = norm(name);
  for (const c of cities) {
    const hit = data.byNameCity[`${n}|${normCity(c)}`];
    if (hit) return hit;
  }
  return data.byName[n] || null;
}
