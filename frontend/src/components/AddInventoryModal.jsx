import { useState } from 'react';
import { api } from '../api/client.js';
import { CITIES } from '../utils/format.js';

const initial = {
  source: 'manual',
  city: 'Noida',
  locality: '',
  society: '',
  bedrooms: '',
  area_sqft: '',
  floor: '',
  price: '',
  seller_name: '',
  posting_date: '',
  listing_link: '',
};

export default function AddInventoryModal({ onClose, onAdded }) {
  const [f, setF] = useState(initial);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function set(k, v) { setF((p) => ({ ...p, [k]: v })); }

  async function submit() {
    setError(null);
    try {
      setSubmitting(true);
      const payload = {
        ...f,
        bedrooms: f.bedrooms === '' ? null : Number(f.bedrooms),
        area_sqft: f.area_sqft === '' ? null : Number(f.area_sqft),
        price: f.price === '' ? null : Number(f.price),
        posting_date: f.posting_date || null,
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
          <div><label>Source</label><input value={f.source} onChange={(e) => set('source', e.target.value)} /></div>
          <div><label>City</label>
            <select value={f.city} onChange={(e) => set('city', e.target.value)}>
              {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div><label>Locality</label><input value={f.locality} onChange={(e) => set('locality', e.target.value)} /></div>
          <div><label>Society *</label><input value={f.society} onChange={(e) => set('society', e.target.value)} /></div>
          <div><label>Bedrooms</label><input type="number" value={f.bedrooms} onChange={(e) => set('bedrooms', e.target.value)} /></div>
          <div><label>Area (sqft)</label><input type="number" value={f.area_sqft} onChange={(e) => set('area_sqft', e.target.value)} /></div>
          <div><label>Floor</label><input value={f.floor} onChange={(e) => set('floor', e.target.value)} /></div>
          <div><label>Price (₹)</label><input type="number" value={f.price} onChange={(e) => set('price', e.target.value)} /></div>
          <div><label>Seller name</label><input value={f.seller_name} onChange={(e) => set('seller_name', e.target.value)} /></div>
          <div><label>Posting date</label><input type="date" value={f.posting_date} onChange={(e) => set('posting_date', e.target.value)} /></div>
          <div className="form-wide"><label>Listing link *</label><input value={f.listing_link} onChange={(e) => set('listing_link', e.target.value)} placeholder="https://www.99acres.com/…" /></div>
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
