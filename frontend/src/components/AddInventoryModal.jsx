import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { CITIES } from '../utils/format.js';

const initial = {
  source: 'Website',
  city: 'Gurgaon',
  society: '',
  locality: '',
  bedrooms: '',
  area_sqft: '',
  floor: '',
  tower: '',
  unit_no: '',
  price: '',
  seller_name: '',
  posting_date: '',
  listing_link: '',
};

export default function AddInventoryModal({ onClose, onAdded }) {
  const [f, setF] = useState(initial);
  const [societies, setSocieties] = useState([]);
  const [loadingSocieties, setLoadingSocieties] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function set(k, v) { setF((p) => ({ ...p, [k]: v })); }

  // Load societies for the selected city. Keeps any user-typed society value.
  useEffect(() => {
    let alive = true;
    setLoadingSocieties(true);
    api.get(`/api/inventory/societies?city=${encodeURIComponent(f.city)}`)
      .then((r) => { if (alive) setSocieties(r.items || []); })
      .catch(() => { if (alive) setSocieties([]); })
      .finally(() => { if (alive) setLoadingSocieties(false); });
    return () => { alive = false; };
  }, [f.city]);

  // When the user picks a society from the master list, auto-fill its locality.
  function handleSocietyChange(value) {
    set('society', value);
    const match = societies.find((s) => s.society === value);
    if (match && match.locality) set('locality', match.locality);
  }

  // Distinct localities derived from the societies list — feeds the locality datalist.
  const localityOptions = Array.from(new Set(
    societies.map((s) => s.locality).filter(Boolean),
  )).sort();

  async function submit() {
    setError(null);
    if (!f.city || !f.society) {
      setError('City and Society are required');
      return;
    }
    try {
      setSubmitting(true);
      const payload = {
        ...f,
        bedrooms: f.bedrooms === '' ? null : Number(f.bedrooms),
        area_sqft: f.area_sqft === '' ? null : Number(f.area_sqft),
        // Form field is in lakhs; DB stores rupees as a BIGINT.
        price: f.price === '' ? null : Math.round(Number(f.price) * 100000),
        posting_date: f.posting_date || null,
        listing_link: (f.listing_link || '').trim() || null,
      };
      const r = await api.post('/api/inventory', payload);
      onAdded(r);
    } catch (e) {
      setError(e.data?.error || e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>Add Inventory</h3>
        <div className="form-grid">
          <div>
            <label>Source</label>
            <input value={f.source} onChange={(e) => set('source', e.target.value)} />
          </div>
          <div>
            <label>City <span className="req">*</span></label>
            <select value={f.city} onChange={(e) => { set('city', e.target.value); set('society', ''); set('locality', ''); }}>
              {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label>Society <span className="req">*</span></label>
            <input
              list="society-options"
              value={f.society}
              onChange={(e) => handleSocietyChange(e.target.value)}
              placeholder={loadingSocieties ? 'Loading…' : 'Type or pick…'}
            />
            <datalist id="society-options">
              {societies.map((s) => (
                <option key={`${s.society}|${s.locality || ''}`} value={s.society}>
                  {s.locality ? `(${s.locality})` : ''}
                </option>
              ))}
            </datalist>
          </div>

          <div>
            <label>Locality</label>
            <input
              list="locality-options"
              value={f.locality}
              onChange={(e) => set('locality', e.target.value)}
              placeholder="Type or pick…"
            />
            <datalist id="locality-options">
              {localityOptions.map((l) => <option key={l} value={l} />)}
            </datalist>
          </div>
          <div>
            <label>BHK</label>
            <select value={f.bedrooms} onChange={(e) => set('bedrooms', e.target.value)}>
              <option value="">Select…</option>
              <option value="2">2 BHK</option>
              <option value="3">3 BHK</option>
              <option value="4">4 BHK</option>
            </select>
          </div>
          <div>
            <label>Area (sqft)</label>
            <input type="number" value={f.area_sqft} onChange={(e) => set('area_sqft', e.target.value)} />
          </div>

          <div>
            <label>Floor</label>
            <select value={f.floor} onChange={(e) => set('floor', e.target.value)}>
              <option value="">Select…</option>
              <option value="Ground">Ground</option>
              <option value="Top">Top</option>
              {Array.from({ length: 50 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={String(n)}>{n}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Tower</label>
            <input value={f.tower} onChange={(e) => set('tower', e.target.value)} placeholder="e.g. T3" />
          </div>
          <div>
            <label>Unit No.</label>
            <input value={f.unit_no} onChange={(e) => set('unit_no', e.target.value)} placeholder="e.g. 1502" />
          </div>
          <div>
            <label>Asking Price (in lakhs)</label>
            <input
              type="number"
              step="0.01"
              value={f.price}
              onChange={(e) => set('price', e.target.value)}
              placeholder="e.g. 150 = ₹1.5 Cr"
            />
          </div>
          <div>
            <label>Seller Name</label>
            <input value={f.seller_name} onChange={(e) => set('seller_name', e.target.value)} />
          </div>

          <div>
            <label>Posting Date</label>
            <input type="date" value={f.posting_date} onChange={(e) => set('posting_date', e.target.value)} />
          </div>
          <div className="form-wide-2">
            <label>Listing link <span className="muted">(optional)</span></label>
            <input value={f.listing_link} onChange={(e) => set('listing_link', e.target.value)} placeholder="https://www.99acres.com/… (leave blank for manual entries)" />
          </div>
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Adding…' : 'Add Inventory'}
          </button>
        </div>
      </div>
    </div>
  );
}
