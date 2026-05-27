import { useEffect, useMemo, useState } from 'react';
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
  // suggest_city used to be picked by the user — now it auto-syncs from the
  // board's active city tab (`defaultCity` prop). Empty → all cities.
  suggest_city: '',
  society: [], locality: [], bhk: [],
  price_min: '', price_max: '',
  variation_min: '', variation_max: '',
  source: '',
  rm_id: '',
  date_preset: '',
  posting_from: '', posting_to: '', posting_empty: false,
  follow_up_preset: '',
  follow_up_from: '', follow_up_to: '', follow_up_empty: false,
  star: [],
};

// Star filter options (admin-only). Keys match the backend `star` param;
// colours mirror the rendered star.
const STAR_OPTIONS = [
  { key: 'partial',   label: 'Partial',   color: '#dc2626' },
  { key: 'perfect',   label: 'Perfect',   color: '#16a34a' },
  { key: 'important', label: 'Important', color: '#eab308' },
  { key: 'blank',     label: 'Blank',     color: '#cbd5e1' },
];

// Normalize legacy single-string society values to arrays so saved filter
// state from before the multi-select change still hydrates the panel.
function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  return [String(v)];
}

function ChipMultiSelect({ id, values, options, onChange, placeholder, disabled }) {
  const [draft, setDraft] = useState('');
  const remaining = options.filter((o) => !values.includes(o));

  function add(v) {
    const t = (v || '').trim();
    if (!t) return;
    // Accept only known options (datalist picks); silently ignore typos.
    const match = options.find((o) => o.toLowerCase() === t.toLowerCase());
    if (!match || values.includes(match)) return;
    onChange([...values, match]);
    setDraft('');
  }

  return (
    <>
      {values.length > 0 && (
        <div className="bhk-pills" style={{ marginBottom: 6 }}>
          {values.map((v) => (
            <span key={v} className="pill pill-on" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {v}
              <button
                type="button"
                onClick={() => onChange(values.filter((x) => x !== v))}
                style={{ background: 'transparent', border: 0, color: '#fff', fontSize: 14, cursor: 'pointer', padding: 0, lineHeight: 1 }}
                aria-label={`Remove ${v}`}
              >×</button>
            </span>
          ))}
        </div>
      )}
      <input
        list={id}
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          // Datalist pick: value matches an option exactly → auto-add.
          if (options.includes(v)) add(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(draft); }
        }}
      />
      <datalist id={id}>
        {remaining.map((o) => <option key={o} value={o} />)}
      </datalist>
    </>
  );
}

export default function FilterPanel({ initial, defaultCity = '', role, onApply, onClose }) {
  const isAdmin = role === 'admin';
  // Admin + manager can filter by RM; an RM only ever sees their own rows.
  const canFilterRm = role === 'admin' || role === 'manager';
  const [f, setF] = useState(() => ({
    ...EMPTY,
    suggest_city: defaultCity,
    ...initial,
    society:  toArray(initial?.society),
    locality: toArray(initial?.locality),
    bhk:      Array.isArray(initial?.bhk) ? initial.bhk : [],
    star:     Array.isArray(initial?.star) ? initial.star : [],
    rm_id:    initial?.rm_id != null && initial?.rm_id !== '' ? String(initial.rm_id) : '',
  }));
  const [societies, setSocieties] = useState([]);
  const [loadingSocs, setLoadingSocs] = useState(false);
  const [rms, setRms] = useState([]);

  // RM list for the assignment filter dropdown (admin/manager only).
  useEffect(() => {
    if (!canFilterRm) return;
    let alive = true;
    api.get('/api/users?role=rm')
      .then((r) => {
        if (!alive) return;
        const active = (r.items || []).filter((u) => u.is_active);
        active.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
        setRms(active);
      })
      .catch(() => { if (alive) setRms([]); });
    return () => { alive = false; };
  }, [canFilterRm]);

  const societyOptions = useMemo(
    () => [...new Set(societies.map((s) => s.society).filter(Boolean))].sort(),
    [societies],
  );
  const localityOptions = useMemo(
    () => [...new Set(societies.map((s) => (s.locality || '').trim()).filter(Boolean))].sort(),
    [societies],
  );

  // Society / locality suggestions: scope to the board's active city tab when
  // set; otherwise fetch across all cities so the chip pickers still work on
  // the "All" tab. Three small requests merged client-side is fine.
  useEffect(() => {
    let alive = true;
    setLoadingSocs(true);
    const cities = f.suggest_city ? [f.suggest_city] : CITIES;
    Promise.all(
      cities.map((c) => api.get(`/api/inventory/societies?city=${encodeURIComponent(c)}`)),
    )
      .then((results) => {
        if (!alive) return;
        setSocieties(results.flatMap((r) => r.items || []));
      })
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

  function toggleStar(key) {
    setF((p) => ({
      ...p,
      star: p.star.includes(key) ? p.star.filter((x) => x !== key) : [...p.star, key],
    }));
  }

  function applyPreset(name) {
    // Click the active preset again to clear it.
    setF((p) => {
      if (p.date_preset === name) {
        return { ...p, date_preset: '', posting_from: '', posting_to: '', posting_empty: false };
      }
      if (name === 'empty') {
        return { ...p, date_preset: 'empty', posting_from: '', posting_to: '', posting_empty: true };
      }
      const { from, to } = preset(name);
      return { ...p, date_preset: name, posting_from: from, posting_to: to, posting_empty: false };
    });
  }

  function applyFollowUpPreset(name) {
    setF((p) => {
      if (p.follow_up_preset === name) {
        return { ...p, follow_up_preset: '', follow_up_from: '', follow_up_to: '', follow_up_empty: false };
      }
      if (name === 'empty') {
        return { ...p, follow_up_preset: 'empty', follow_up_from: '', follow_up_to: '', follow_up_empty: true };
      }
      const { from, to } = preset(name);
      return { ...p, follow_up_preset: name, follow_up_from: from, follow_up_to: to, follow_up_empty: false };
    });
  }

  function reset() { setF(EMPTY); }

  function apply() {
    // Strip empties so the URL stays clean.
    const out = {};
    if (f.society.length) out.society = f.society.join(',');
    if (f.locality.length) out.locality = f.locality.join(',');
    if (f.bhk.length) out.bhk = f.bhk.join(',');
    if (f.price_min !== '') out.price_min = Number(f.price_min);
    if (f.price_max !== '') out.price_max = Number(f.price_max);
    if (f.variation_min !== '') out.variation_min = Number(f.variation_min);
    if (f.variation_max !== '') out.variation_max = Number(f.variation_max);
    if (f.source) out.source = f.source;
    if (canFilterRm && f.rm_id) {
      out.rm_id = (f.rm_id === 'none' || f.rm_id === 'multiple') ? f.rm_id : Number(f.rm_id);
    }
    if (f.posting_from) out.posting_from = f.posting_from;
    if (f.posting_to)   out.posting_to   = f.posting_to;
    if (f.posting_empty) out.posting_empty = 1;
    if (f.follow_up_from) out.follow_up_from = f.follow_up_from;
    if (f.follow_up_to)   out.follow_up_to   = f.follow_up_to;
    if (f.follow_up_empty) out.follow_up_empty = 1;
    // Star filter is admin-only — don't emit it for non-admins even if stale
    // state somehow carries a selection.
    if (isAdmin && f.star.length) out.star = f.star.join(',');
    onApply(out, f);  // raw form state preserved so panel reopens with same selection
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal filter-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Filters</h3>

        <div className="filter-grid">
        <div className="filter-block">
          <label>Society</label>
          <ChipMultiSelect
            id="filter-society-options"
            values={f.society}
            options={societyOptions}
            onChange={(v) => set('society', v)}
            placeholder={
              loadingSocs ? 'Loading societies…'
              : f.society.length ? 'Add another society…' : 'Type or pick societies…'
            }
          />
        </div>

        <div className="filter-block">
          <label>Locality</label>
          <ChipMultiSelect
            id="filter-locality-options"
            values={f.locality}
            options={localityOptions}
            onChange={(v) => set('locality', v)}
            placeholder={
              loadingSocs ? 'Loading localities…'
              : f.locality.length ? 'Add another locality…' : 'Type or pick localities…'
            }
          />
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

        {isAdmin && (
          <div className="filter-block">
            <label>Star</label>
            <div className="bhk-pills">
              {STAR_OPTIONS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={f.star.includes(s.key) ? 'pill pill-on' : 'pill'}
                  onClick={() => toggleStar(s.key)}
                >
                  <span style={{ color: s.color, marginRight: 4 }}>★</span>{s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="filter-block">
          <label>Asking price (₹, inclusive)</label>
          <div className="range-row">
            <input type="number" placeholder="min" value={f.price_min}
                   onChange={(e) => set('price_min', e.target.value)} />
            <span className="muted">to</span>
            <input type="number" placeholder="max" value={f.price_max}
                   onChange={(e) => set('price_max', e.target.value)} />
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
          <div className="preset-grid-3">
            {[
              ['today', 'Today'],
              ['yesterday', 'Yesterday'],
              ['this_week', 'This Week'],
              ['this_month', 'This Month'],
              ['custom', 'Custom'],
              ['empty', 'Empty'],
            ].map(([k, lbl]) => {
              const onClickPreset = k === 'custom'
                ? () => set('date_preset', f.date_preset === 'custom' ? '' : 'custom')
                : () => applyPreset(k);
              return (
                <button
                  key={k}
                  type="button"
                  className={f.date_preset === k ? 'pill pill-on' : 'pill'}
                  onClick={onClickPreset}
                >{lbl}</button>
              );
            })}
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
          <label>Follow-up date</label>
          <div className="preset-grid-3">
            {[
              ['today', 'Today'],
              ['yesterday', 'Yesterday'],
              ['this_week', 'This Week'],
              ['this_month', 'This Month'],
              ['custom', 'Custom'],
              ['empty', 'Empty'],
            ].map(([k, lbl]) => {
              const onClickPreset = k === 'custom'
                ? () => set('follow_up_preset', f.follow_up_preset === 'custom' ? '' : 'custom')
                : () => applyFollowUpPreset(k);
              return (
                <button
                  key={k}
                  type="button"
                  className={f.follow_up_preset === k ? 'pill pill-on' : 'pill'}
                  onClick={onClickPreset}
                >{lbl}</button>
              );
            })}
          </div>
          {f.follow_up_preset === 'custom' && (
            <div className="range-row" style={{ marginTop: 8 }}>
              <input type="date" value={f.follow_up_from}
                     onChange={(e) => set('follow_up_from', e.target.value)} />
              <span className="muted">to</span>
              <input type="date" value={f.follow_up_to}
                     onChange={(e) => set('follow_up_to', e.target.value)} />
            </div>
          )}
          {(f.follow_up_from || f.follow_up_to) && f.follow_up_preset !== 'custom' && (
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              {f.follow_up_from || '…'} → {f.follow_up_to || '…'}
            </div>
          )}
        </div>

        <div className="filter-block">
          <label>Source</label>
          <input value={f.source} onChange={(e) => set('source', e.target.value)}
                 placeholder="e.g. 99acres, Website" />
        </div>

        {canFilterRm && (
          <div className="filter-block">
            <label>RM</label>
            <select value={f.rm_id} onChange={(e) => set('rm_id', e.target.value)}>
              <option value="">— All RMs —</option>
              <option value="none">No RM assigned</option>
              <option value="multiple">Multiple RMs</option>
              {rms.map((u) => (
                <option key={u.id} value={String(u.id)}>{u.name || u.email}</option>
              ))}
            </select>
          </div>
        )}

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
