import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { ALL_REJECT_REASONS, CITIES } from '../utils/format.js';
import SearchableMultiSelect from './SearchableMultiSelect.jsx';
import { IconClose } from './icons.jsx';

function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function presetRange(name) {
  const now = new Date();
  if (name === 'today') { const s = isoLocal(now); return { from: s, to: s }; }
  if (name === 'yesterday') { const y = new Date(now); y.setDate(now.getDate() - 1); const s = isoLocal(y); return { from: s, to: s }; }
  if (name === 'this_week') { const dow = (now.getDay() + 6) % 7; const mon = new Date(now); mon.setDate(now.getDate() - dow); return { from: isoLocal(mon), to: isoLocal(now) }; }
  if (name === 'this_month') { const first = new Date(now.getFullYear(), now.getMonth(), 1); return { from: isoLocal(first), to: isoLocal(now) }; }
  return { from: '', to: '' };
}

const STAR_OPTIONS = [
  { key: 'partial', label: 'Partial', color: '#dc2626' },
  { key: 'perfect', label: 'Perfect', color: '#16a34a' },
  { key: 'important', label: 'Important', color: '#eab308' },
  { key: 'blank', label: 'Blank', color: '#cbd5e1' },
];

const DATE_PRESETS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This Week'],
  ['this_month', 'This Month'], ['custom', 'Custom'], ['empty', 'Empty'],
];

const EMPTY = {
  society: [], locality: [], bhk: [], star: [], reason: [],
  price_min: '', price_max: '', variation_min: '', variation_max: '',
  source: '', rm_id: '', rm_ids: [], oh_price: '', no_phone: false, has_phone: false,
  date_preset: '', posting_from: '', posting_to: '', posting_empty: false,
  fu_preset: '', follow_up_from: '', follow_up_to: '', follow_up_empty: false,
};

export default function FilterPanel({ initial, defaultCity = '', role = '', showReason = false, showFollowUp = true, reasonOptions = ALL_REJECT_REASONS, onApply, onClose }) {
  const [f, setF] = useState(() => ({
    ...EMPTY, ...initial,
    society: Array.isArray(initial?.society) ? initial.society : [],
    locality: Array.isArray(initial?.locality) ? initial.locality : [],
    bhk: Array.isArray(initial?.bhk) ? initial.bhk : [],
    star: Array.isArray(initial?.star) ? initial.star : [],
    reason: Array.isArray(initial?.reason) ? initial.reason : [],
    rm_id: initial?.rm_id != null && initial?.rm_id !== '' ? String(initial.rm_id) : '',
    rm_ids: Array.isArray(initial?.rm_ids) ? initial.rm_ids.map(String) : [],
  }));
  const [societies, setSocieties] = useState([]);
  const [loading, setLoading] = useState(false);

  const canFilterRm = role === 'admin' || role === 'manager';
  const [rms, setRms] = useState([]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const cities = defaultCity ? [defaultCity] : CITIES;
    Promise.all(cities.map((c) => api.get(`/api/inventory/societies?city=${encodeURIComponent(c)}`)))
      .then((res) => { if (alive) setSocieties(res.flatMap((r) => r.items || [])); })
      .catch(() => { if (alive) setSocieties([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [defaultCity]);

  useEffect(() => {
    if (!canFilterRm) return undefined;
    let alive = true;
    api.get('/api/users?role=rm')
      .then((r) => { if (alive) setRms((r.items || []).filter((u) => u.is_active !== false)); })
      .catch(() => { if (alive) setRms([]); });
    return () => { alive = false; };
  }, [canFilterRm]);

  const societyOptions = useMemo(() => [...new Set(societies.map((s) => s.society).filter(Boolean))].sort(), [societies]);
  const localityOptions = useMemo(() => [...new Set(societies.map((s) => (s.locality || '').trim()).filter(Boolean))].sort(), [societies]);

  function set(k, v) { setF((p) => ({ ...p, [k]: v })); }
  function toggleBhk(n) { setF((p) => ({ ...p, bhk: p.bhk.includes(n) ? p.bhk.filter((x) => x !== n) : [...p.bhk, n] })); }
  function toggleStar(key) { setF((p) => ({ ...p, star: p.star.includes(key) ? p.star.filter((x) => x !== key) : [...p.star, key] })); }
  function toggleReason(key) { setF((p) => ({ ...p, reason: p.reason.includes(key) ? p.reason.filter((x) => x !== key) : [...p.reason, key] })); }

  function applyPreset(name) {
    setF((p) => {
      if (name === 'custom') return { ...p, date_preset: p.date_preset === 'custom' ? '' : 'custom', posting_empty: false };
      if (name === 'empty') {
        const on = p.date_preset === 'empty';
        return { ...p, date_preset: on ? '' : 'empty', posting_from: '', posting_to: '', posting_empty: !on };
      }
      if (p.date_preset === name) return { ...p, date_preset: '', posting_from: '', posting_to: '', posting_empty: false };
      const { from, to } = presetRange(name);
      return { ...p, date_preset: name, posting_from: from, posting_to: to, posting_empty: false };
    });
  }
  function applyFuPreset(name) {
    setF((p) => {
      if (name === 'custom') return { ...p, fu_preset: p.fu_preset === 'custom' ? '' : 'custom', follow_up_empty: false };
      if (name === 'empty') {
        const on = p.fu_preset === 'empty';
        return { ...p, fu_preset: on ? '' : 'empty', follow_up_from: '', follow_up_to: '', follow_up_empty: !on };
      }
      if (p.fu_preset === name) return { ...p, fu_preset: '', follow_up_from: '', follow_up_to: '', follow_up_empty: false };
      const { from, to } = presetRange(name);
      return { ...p, fu_preset: name, follow_up_from: from, follow_up_to: to, follow_up_empty: false };
    });
  }
  function reset() { setF(EMPTY); }

  function apply() {
    const out = {};
    if (f.society.length) out.society = f.society.join(',');
    if (f.locality.length) out.locality = f.locality.join(',');
    if (f.bhk.length) out.bhk = f.bhk.join(',');
    if (f.star.length) out.star = f.star.join(',');
    if (showReason && f.reason.length) out.reason = f.reason.join(',');
    if (f.price_min !== '') out.price_min = Number(f.price_min);
    if (f.price_max !== '') out.price_max = Number(f.price_max);
    if (f.variation_min !== '') out.variation_min = Number(f.variation_min);
    if (f.variation_max !== '') out.variation_max = Number(f.variation_max);
    if (f.source) out.source = f.source;
    if (f.oh_price) out.oh_price = f.oh_price;
    if (f.no_phone) out.no_phone = 1;
    if (f.has_phone) out.has_phone = 1;
    if (canFilterRm && f.rm_id) out.rm_id = (f.rm_id === 'none' || f.rm_id === 'multiple') ? f.rm_id : Number(f.rm_id);
    if (canFilterRm && f.rm_ids?.length) out.rm_ids = f.rm_ids.join(',');
    if (f.posting_from) out.posting_from = f.posting_from;
    if (f.posting_to) out.posting_to = f.posting_to;
    if (f.posting_empty) out.posting_empty = 1;
    if (f.follow_up_from) out.follow_up_from = f.follow_up_from;
    if (f.follow_up_to) out.follow_up_to = f.follow_up_to;
    if (f.follow_up_empty) out.follow_up_empty = 1;
    onApply(out, f);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal filter-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head-row">
          <h3>Filters</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>

        <div className="filter-grid">
          <div className="filter-block">
            <label>Society</label>
            <SearchableMultiSelect options={societyOptions} value={f.society} onChange={(v) => set('society', v)}
              placeholder={loading ? 'Loading…' : 'Pick societies…'} />
          </div>
          <div className="filter-block">
            <label>Locality</label>
            <SearchableMultiSelect options={localityOptions} value={f.locality} onChange={(v) => set('locality', v)}
              placeholder={loading ? 'Loading…' : 'Pick localities…'} />
          </div>

          <div className="filter-block">
            <label>BHK</label>
            <div className="bhk-pills">
              {[1, 2, 2.5, 3, 3.5, 4, 5].map((n) => (
                <button key={n} type="button" className={f.bhk.includes(n) ? 'pill pill-on' : 'pill'} onClick={() => toggleBhk(n)}>{n} BHK</button>
              ))}
              <button type="button" className={f.bhk.includes('other') ? 'pill pill-on' : 'pill'} onClick={() => toggleBhk('other')} title="BHK values outside the standard options">Other</button>
            </div>
          </div>
          <div className="filter-block">
            <label>Source</label>
            <input type="text" value={f.source} onChange={(e) => set('source', e.target.value)} placeholder="e.g. 99acres, Website" />
          </div>

          <div className="filter-block">
            <label>OH Price</label>
            <div className="bhk-pills">
              <button type="button" className={f.oh_price === 'missing' ? 'pill pill-on' : 'pill'} onClick={() => set('oh_price', f.oh_price === 'missing' ? '' : 'missing')}>Check Price (no match)</button>
              <button type="button" className={f.oh_price === 'matched' ? 'pill pill-on' : 'pill'} onClick={() => set('oh_price', f.oh_price === 'matched' ? '' : 'matched')}>Has OH Price</button>
            </div>
          </div>

          <div className="filter-block">
            <label>Contact</label>
            <div className="bhk-pills">
              <button type="button" className={f.has_phone ? 'pill pill-on' : 'pill'}
                onClick={() => setF((p) => ({ ...p, has_phone: !p.has_phone, no_phone: false }))}>Has Contact No.</button>
              <button type="button" className={f.no_phone ? 'pill pill-on' : 'pill'}
                onClick={() => setF((p) => ({ ...p, no_phone: !p.no_phone, has_phone: false }))}>No phone no.</button>
            </div>
          </div>

          <div className="filter-block">
            <label>Star</label>
            <div className="bhk-pills">
              {STAR_OPTIONS.map((s) => (
                <button key={s.key} type="button" className={f.star.includes(s.key) ? 'pill pill-on' : 'pill'} onClick={() => toggleStar(s.key)}>
                  <span style={{ color: s.color, marginRight: 4 }}>★</span>{s.label}
                </button>
              ))}
            </div>
          </div>
          {canFilterRm && (
            <div className="filter-block">
              <label>RM</label>
              <SearchableMultiSelect
                options={rms.map((u) => ({ value: String(u.id), label: u.name || u.email }))}
                value={f.rm_ids}
                onChange={(v) => setF((p) => ({ ...p, rm_ids: v, rm_id: v.length ? '' : p.rm_id }))}
                placeholder="Pick RMs…" />
              <div className="bhk-pills" style={{ marginTop: 6 }}>
                <button type="button" className={f.rm_id === 'none' ? 'pill pill-on' : 'pill'}
                  onClick={() => setF((p) => ({ ...p, rm_id: p.rm_id === 'none' ? '' : 'none', rm_ids: [] }))}>No RM assigned</button>
                <button type="button" className={f.rm_id === 'multiple' ? 'pill pill-on' : 'pill'}
                  onClick={() => setF((p) => ({ ...p, rm_id: p.rm_id === 'multiple' ? '' : 'multiple', rm_ids: [] }))}>Multiple RMs</button>
              </div>
            </div>
          )}

          {showReason && (
            <div className="filter-block" style={{ gridColumn: '1 / -1' }}>
              <label>Reason</label>
              <div className="bhk-pills">
                {reasonOptions.map((r) => (
                  <button key={r.value} type="button" className={f.reason.includes(r.value) ? 'pill pill-on' : 'pill'} onClick={() => toggleReason(r.value)}>{r.label}</button>
                ))}
              </div>
            </div>
          )}

          <div className="filter-block">
            <label>Asking price (₹)</label>
            <div className="range-row">
              <input type="number" placeholder="min" value={f.price_min} onChange={(e) => set('price_min', e.target.value)} />
              <span className="muted">to</span>
              <input type="number" placeholder="max" value={f.price_max} onChange={(e) => set('price_max', e.target.value)} />
            </div>
          </div>
          <div className="filter-block">
            <label>Variation (%)</label>
            <div className="range-row">
              <input type="number" placeholder="min %" step="0.1" value={f.variation_min} onChange={(e) => set('variation_min', e.target.value)} />
              <span className="muted">to</span>
              <input type="number" placeholder="max %" step="0.1" value={f.variation_max} onChange={(e) => set('variation_max', e.target.value)} />
            </div>
          </div>

          <div className="filter-block" style={{ gridColumn: '1 / -1' }}>
            <label>Date posted</label>
            <div className="preset-grid-3">
              {DATE_PRESETS.map(([k, lbl]) => (
                <button key={k} type="button" className={f.date_preset === k ? 'pill pill-on' : 'pill'} onClick={() => applyPreset(k)}>{lbl}</button>
              ))}
            </div>
            {f.date_preset === 'custom' && (
              <div className="range-row" style={{ marginTop: 8 }}>
                <input type="date" value={f.posting_from} onChange={(e) => set('posting_from', e.target.value)} />
                <span className="muted">to</span>
                <input type="date" value={f.posting_to} onChange={(e) => set('posting_to', e.target.value)} />
              </div>
            )}
          </div>

          {showFollowUp && (
            <div className="filter-block" style={{ gridColumn: '1 / -1' }}>
              <label>Follow-up date</label>
              <div className="preset-grid-3">
                {DATE_PRESETS.map(([k, lbl]) => (
                  <button key={k} type="button" className={f.fu_preset === k ? 'pill pill-on' : 'pill'} onClick={() => applyFuPreset(k)}>{lbl}</button>
                ))}
              </div>
              {f.fu_preset === 'custom' && (
                <div className="range-row" style={{ marginTop: 8 }}>
                  <input type="date" value={f.follow_up_from} onChange={(e) => set('follow_up_from', e.target.value)} />
                  <span className="muted">to</span>
                  <input type="date" value={f.follow_up_to} onChange={(e) => set('follow_up_to', e.target.value)} />
                </div>
              )}
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
