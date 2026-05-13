import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { CITIES } from '../utils/format.js';

/**
 * Filter panel modal. Holds its own draft state until the user clicks Apply.
 * Date posted: preset chips compute the ISO dates locally and update
 * (posting_from, posting_to) atomically.
 */

// Returns YYYY-MM-DD for a given Date in local time.
function isoLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function preset(name) {
  const now = new Date();
  if (name === 'today') {
    const s = isoLocal(now);
    return { from: s, to: s };
  }
  if (name === 'yesterday') {
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    const s = isoLocal(y);
    return { from: s, to: s };
  }
  if (name === 'this_week') {
    // Mon-Sun. JS getDay: 0=Sun..6=Sat.
    const dow = now.getDay();
    const daysFromMon = (dow + 6) % 7;
    const mon = new Date(now);
    mon.setDate(now.getDate() - daysFromMon);
    return { from: isoLocal(mon), to: isoLocal(now) };
  }
  if (name === 'this_month') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: isoLocal(first), to: isoLocal(now) };
  }
  return { from: '', to: '' };
}

const EMPTY = {
  // suggest_city scopes the Society autocomplete suggestions only.
  // It does NOT become a board-level city filter (top tabs do that).
  suggest_city: '',
  society: '', bhk: [],
  price_min: '', price_max: '',
  variation_min: '', variation_max: '',
  source: '',
  date_preset: '',
  posting_from: '', posting_to: '',
};

export default function FilterPanel({ initial, defaultCity = '', onApply, onClose }) {
  const [f, setF] = useState({ ...EMPTY, suggest_city: defaultCity, ...initial });
  const [societies, setSocieties] = useState([]);
  const [loadingSocs, setLoadingSocs] = useState(false);

  // Fetch society suggestions for the selected scope city. Empty city → no suggestions
  // (1138 societies across all cities is too noisy to show without a scope).
  useEffect(() => {
    if (!f.suggest_city) { setSocieties([]); return; }
    let alive = true;
    setLoadingSocs(true);
    api.get(`/api/inventory/societies?city=${encodeURIComponent(f.suggest_city)}`)
      .then((r) => { if (alive) setSocieties(r.items || []); })
      .catch(() => { if (alive) setSocieties([]); })
      .finally(() => { if (alive) setLoadingSocs(false); });
    return () => { alive = false; };
  }, [f.suggest_city]);

  function set(k, v) { setF((p) => ({ ...p, [k]: v })); }

  function toggleBhk(n) {
    setF((p) => ({
      ...p,
      bhk: p.bhk.includes(n) ? p.bhk.filter((x) => x !== n) : [...p.bhk, n],
    }));
  }

  function applyPreset(name) {
    const { from, to } = preset(name);
    setF((p) => ({ ...p, date_preset: name, posting_from: from, posting_to: to }));
  }

  function reset() { setF(EMPTY); }

  function apply() {
    // Strip empties so the URL stays clean.
    const out = {};
    if (f.society) out.society = f.society;
    if (f.bhk.length) out.bhk = f.bhk.join(',');
    if (f.price_min !== '') out.price_min = Number(f.price_min);
    if (f.price_max !== '') out.price_max = Number(f.price_max);
    if (f.variation_min !== '') out.variation_min = Number(f.variation_min);
    if (f.variation_max !== '') out.variation_max = Number(f.variation_max);
    if (f.source) out.source = f.source;
    if (f.posting_from) out.posting_from = f.posting_from;
    if (f.posting_to)   out.posting_to   = f.posting_to;
    onApply(out, f);  // raw form state preserved so panel reopens with same selection
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>Filters</h3>

        <div className="filter-block">
          <div className="society-row">
            <div className="society-city">
              <label>City <span className="muted">(scopes suggestions)</span></label>
              <select value={f.suggest_city} onChange={(e) => set('suggest_city', e.target.value)}>
                <option value="">— pick city —</option>
                {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="society-input">
              <label>Society</label>
              <input
                list="filter-society-options"
                value={f.society}
                onChange={(e) => set('society', e.target.value)}
                placeholder={
                  !f.suggest_city ? 'Pick a city to see suggestions…'
                  : loadingSocs ? 'Loading societies…'
                  : 'Type or pick a society…'
                }
              />
              <datalist id="filter-society-options">
                {societies.map((s) => (
                  <option key={`${s.society}|${s.locality || ''}`} value={s.society}>
                    {s.locality ? `(${s.locality})` : ''}
                  </option>
                ))}
              </datalist>
            </div>
          </div>
        </div>

        <div className="filter-block">
          <label>BHK</label>
          <div className="bhk-pills">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={f.bhk.includes(n) ? 'pill pill-on' : 'pill'}
                onClick={() => toggleBhk(n)}
              >{n} BHK</button>
            ))}
          </div>
        </div>

        <div className="filter-block">
          <label>Asking price (₹, inclusive)</label>
          <div className="range-row">
            <input type="number" placeholder="min" value={f.price_min}
                   onChange={(e) => set('price_min', e.target.value)} />
            <span className="muted">to</span>
            <input type="number" placeholder="max" value={f.price_max}
                   onChange={(e) => set('price_max', e.target.value)} />
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            Tip: 1 Cr = 10000000 · 50 L = 5000000
          </div>
        </div>

        <div className="filter-block">
          <label>Variation (% — Asking vs OH Price)</label>
          <div className="range-row">
            <input type="number" placeholder="min %" value={f.variation_min} step="0.1"
                   onChange={(e) => set('variation_min', e.target.value)} />
            <span className="muted">to</span>
            <input type="number" placeholder="max %" value={f.variation_max} step="0.1"
                   onChange={(e) => set('variation_max', e.target.value)} />
          </div>
        </div>

        <div className="filter-block">
          <label>Date posted</label>
          <div className="bhk-pills">
            {[
              ['today', 'Today'],
              ['yesterday', 'Yesterday'],
              ['this_week', 'This Week'],
              ['this_month', 'This Month'],
            ].map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                className={f.date_preset === k ? 'pill pill-on' : 'pill'}
                onClick={() => applyPreset(k)}
              >{lbl}</button>
            ))}
            <button
              type="button"
              className={f.date_preset === 'custom' ? 'pill pill-on' : 'pill'}
              onClick={() => set('date_preset', 'custom')}
            >Custom</button>
          </div>
          {f.date_preset === 'custom' && (
            <div className="range-row" style={{ marginTop: 8 }}>
              <input type="date" value={f.posting_from}
                     onChange={(e) => set('posting_from', e.target.value)} />
              <span className="muted">to</span>
              <input type="date" value={f.posting_to}
                     onChange={(e) => set('posting_to', e.target.value)} />
            </div>
          )}
          {(f.posting_from || f.posting_to) && f.date_preset !== 'custom' && (
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              {f.posting_from || '…'} → {f.posting_to || '…'}
            </div>
          )}
        </div>

        <div className="filter-block">
          <label>Source</label>
          <input value={f.source} onChange={(e) => set('source', e.target.value)}
                 placeholder="e.g. 99acres, Website" />
        </div>

        <div className="modal-actions">
          <button className="btn-ghost" onClick={reset}>Reset</button>
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  );
}
