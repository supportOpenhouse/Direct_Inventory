// Thin fetch wrapper around the Flask API, with a mock fallback.
//
// The backend is built later. Until then VITE_USE_MOCKS (default "true") makes
// every call resolve from src/api/mock.js. Even with mocks off, a network
// failure (no server) transparently falls back to mocks so the UI never hard-
// crashes during local dev. Flip VITE_USE_MOCKS=false once the backend is live
// and reachable to go fully real.

import { mockApi } from './mock.js';

const BASE = import.meta.env.VITE_API_BASE || '';
const FORCE_MOCKS = String(import.meta.env.VITE_USE_MOCKS ?? 'true') !== 'false';

let token = null;
export function setAuthToken(t) {
  token = t;
  // User changed (login/logout) — drop everything cached for the old identity.
  epoch += 1;
  cache.clear();
  inflight.clear();
}

function fromMock(method, path, body) {
  // Simulate a tiny latency so loading states are visible.
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        const data = mockApi(method, path, body);
        resolve(data);
      } catch (e) {
        const err = new Error(e?.data?.error || 'mock error');
        err.status = e?.status || 500;
        err.data = e?.data;
        reject(err);
      }
    }, 120);
  });
}

async function request(method, path, body) {
  if (FORCE_MOCKS) return fromMock(method, path, body);

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch {
    // Real backend selected but unreachable. Do NOT fall back to mocks here —
    // for writes that would fake success and silently drop the change (e.g. a
    // qualify that never reaches the DB). Surface the error so optimistic UI can
    // revert/retry. (Set VITE_USE_MOCKS=true for the no-backend mock dev mode.)
    const err = new Error('Network error — could not reach the server. Please retry.');
    err.status = 0;
    throw err;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Authenticated GET returning the raw response Blob — for file downloads
// (CSV export) where the JSON wrapper doesn't apply. Needs the real backend.
async function download(path) {
  if (FORCE_MOCKS) throw new Error('Downloads require the live backend (VITE_USE_MOCKS=false).');
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    try { err.data = JSON.parse(text); } catch { /* non-JSON error body */ }
    throw err;
  }
  return res.blob();
}

// Tiny in-memory GET layer: identical concurrent GETs share one promise, and a
// few hot read endpoints get a short TTL cache (keyed on full path+query).
// Any write wipes the whole cache — correctness over cleverness. Cache hits
// hand out structuredClone copies so components can't mutate shared data.

// Path-prefix → TTL in seconds. First match wins (most specific first).
// Caching is safe even for live data: any write (post/put/patch/delete) wipes
// the whole cache in mutate(), so a cached page only ever survives until the
// next mutation or its TTL — whichever comes first. The inventory-list and
// home-summary rules below are what make navigating BACK to a board instant
// (the table is served from cache instead of refetched).
// Every API caches for 10 min; the Home summary for 5 min. Any write still
// wipes the whole cache (mutate), so your own edits are never stale.
const TTL_RULES = [
  ['/api/home/summary', 300],       // Home cards — 5 min
  ['/api/users/master-areas', 600],
  ['/api/inventory/societies', 600],
  ['/api/inventory/counts', 600],
  ['/api/inventory/notifications', 600],
  ['/api/inventory?', 600],
  ['/api/tickets/pending-count', 10],   // live ticket badge — keep short
  ['/api/tickets?oh_id=', 600],
  ['/api/tickets?', 600],
  ['/api/geo/', 600],
  ['/api/users', 600],
];
// Single-record detail (/api/inventory/<oh_id>) — re-expanding a row shouldn't
// refetch. Static sub-routes are excluded; /<oh_id>/visible-rms has an extra
// segment so it never matches.
const INV_DETAIL_RE = /^\/api\/inventory\/(?!counts$|ids$|badges|notifications$|societies|export)[^/?]+$/;
function ttlFor(path) {
  // Single-record detail (opened from the bell / Logs UID) — cache 10 min so
  // re-opening an already-viewed oh_id never refetches. Any write clears it.
  if (INV_DETAIL_RE.test(path)) return 600 * 1000;
  const rule = TTL_RULES.find(([prefix]) => path.startsWith(prefix));
  return rule ? rule[1] * 1000 : 0;
}

const cache = new Map();    // path -> { data, expires }
const inflight = new Map(); // path -> promise
let epoch = 0;              // bumped on writes so stale in-flight GETs never cache

function cachedGet(path, fresh = false) {
  // fresh=true skips the cache READ (explicit Reload / auto-sync want a network
  // hit), but still joins an in-flight fetch and still refreshes the cache.
  if (!fresh) {
    const hit = cache.get(path);
    if (hit && hit.expires > Date.now()) return Promise.resolve(structuredClone(hit.data));
  }
  let p = inflight.get(path);
  if (!p) {
    const started = epoch;
    p = request('GET', path)
      .then((data) => {
        const ttl = ttlFor(path);
        if (ttl && epoch === started) cache.set(path, { data, expires: Date.now() + ttl });
        return data;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, p);
  }
  return p.then((data) => structuredClone(data));
}

// Global busy counter for writes — BusyOverlay listens to 'api:busy' and
// shows a "Saving…" animation while any mutation is awaiting its response.
let busyCount = 0;
function busyDelta(d) {
  busyCount = Math.max(0, busyCount + d);
  window.dispatchEvent(new CustomEvent('api:busy', { detail: busyCount }));
}

function mutate(method, path, body, opts = {}) {
  if (!opts.silent) busyDelta(1);
  return request(method, path, body).finally(() => {
    if (!opts.silent) busyDelta(-1);
    epoch += 1;
    cache.clear();
    // Drop in-flight GETs too: a fetch issued after this write must not
    // join a pre-write request and render stale rows.
    inflight.clear();
  });
}

// Targeted invalidation for cross-user changes detected by polling (our own
// writes already clear everything via mutate()).
function invalidate(prefix) {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
  for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k);
}

export const api = {
  get: (p, opts) => cachedGet(p, opts?.fresh),
  // opts.silent = true skips the global "Saving…" overlay (for background
  // writes that shouldn't block the user, e.g. fire-and-forget syncs).
  post: (p, b, opts) => mutate('POST', p, b, opts),
  put: (p, b, opts) => mutate('PUT', p, b, opts),
  patch: (p, b, opts) => mutate('PATCH', p, b, opts),
  delete: (p, opts) => mutate('DELETE', p, undefined, opts),
  download,
  invalidate,
};

export const USING_MOCKS = FORCE_MOCKS;
