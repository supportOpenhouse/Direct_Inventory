import { useState } from 'react';
import { api } from '../api/client.js';
import { foldCities } from '../utils/format.js';
import SearchableMultiSelect from './SearchableMultiSelect.jsx';
import { IconClose } from './icons.jsx';

const SCOPE_LEVELS = [
  { key: 'city', label: 'City' },
  { key: 'micro_market', label: 'Micro-market' },
  { key: 'society', label: 'Society' },
];

export default function UserEditModal({ user, managers, areas, onClose, onSaved }) {
  const [cities, setCities] = useState(foldCities(user.cities));
  const [microMarkets, setMicroMarkets] = useState(user.micro_market || []);
  const [societies, setSocieties] = useState(user.society || []);
  const [manager, setManager] = useState(user.manager || '');
  const [isActive, setIsActive] = useState(!!user.is_active);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const valueFor = { city: cities, micro_market: microMarkets, society: societies };
  const setterFor = { city: setCities, micro_market: setMicroMarkets, society: setSocieties };
  const optionsFor = { city: foldCities(areas.cities), micro_market: areas.micro_markets || [], society: areas.societies || [] };

  async function save() {
    setError(null); setSaving(true);
    try {
      const body = { is_active: isActive, manager: manager ? Number(manager) : null, cities, micro_market: microMarkets, society: societies };
      onSaved(await api.patch(`/api/users/${user.id}`, body));
    } catch (e) { setError(e.data?.error || e.message); } finally { setSaving(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head-row"><h3>{user.name || user.email}</h3><span className="role-chip">{user.role}</span><span className="muted" style={{ fontSize: 12 }}>{user.email}</span><button className="modal-close" onClick={onClose}><IconClose /></button></div>

        <div style={{ marginBottom: 16 }}>
          <label>Status</label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            <span>{isActive ? 'Active' : 'Inactive'}</span>
          </label>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label>Manager</label>
          <select className="role-select" value={manager} onChange={(e) => setManager(e.target.value)}>
            <option value="">— none —</option>
            {managers.filter((m) => m.id !== user.id).map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
          </select>
        </div>

        <div>
          <label>Area scope</label>
          <p className="page-hint">Set any combination. Assignment matches society first, then micro-market. City is used for manager visibility.</p>
          <div className="form-grid">
            {SCOPE_LEVELS.map((lvl) => (
              <div key={lvl.key}>
                <label>{lvl.label} <span className="muted">{valueFor[lvl.key].length || ''}</span></label>
                <SearchableMultiSelect options={optionsFor[lvl.key]} value={valueFor[lvl.key]} onChange={setterFor[lvl.key]} placeholder={`Select ${lvl.label.toLowerCase()}…`} />
              </div>
            ))}
          </div>
        </div>

        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions"><span style={{ flex: 1 }} /><button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button><button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
      </div>
    </div>
  );
}
