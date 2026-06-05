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
export function setAuthToken(t) { token = t; }

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

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  delete: (p) => request('DELETE', p),
};

export const USING_MOCKS = FORCE_MOCKS;
