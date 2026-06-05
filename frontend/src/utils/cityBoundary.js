import { api } from '../api/client.js';

// city name → GeoJSON geometry (Polygon/MultiPolygon) or null. Cached in-module.
const cache = {};

export async function cityBoundary(city) {
  if (!city) return null;
  const k = city.toLowerCase();
  if (k in cache) return cache[k];
  try {
    const r = await api.get(`/api/geo/city-boundary?city=${encodeURIComponent(city)}`);
    cache[k] = r.geometry || null;
  } catch {
    cache[k] = null;
  }
  return cache[k];
}
