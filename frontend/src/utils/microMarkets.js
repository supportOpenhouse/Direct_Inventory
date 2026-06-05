import { api } from '../api/client.js';

// Micro-market geometry, fetched once and cached:
//   items:  [{ name, center:[lat,lng], geometry: Polygon|null, count }]
//   byName: normalised name -> item
let _data = null;
let _inflight = null;
const norm = (s) => (s || '').trim().toLowerCase();

export async function microMarkets() {
  if (_data) return _data;
  if (!_inflight) {
    _inflight = api.get('/api/geo/micro-markets')
      .then((r) => {
        const items = r.items || [];
        const byName = {};
        for (const it of items) byName[norm(it.name)] = it;
        _data = { items, byName };
        return _data;
      })
      .catch(() => { _data = { items: [], byName: {} }; return _data; });
  }
  return _inflight;
}

export function lookupMicro(data, name) {
  if (!data || !name) return null;
  return data.byName[norm(name)] || null;
}
