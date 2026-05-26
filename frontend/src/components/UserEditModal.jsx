import { useState } from 'react';
import { api } from '../api/client.js';
import SearchableMultiSelect from './SearchableMultiSelect.jsx';

// Area-scope fields. All three are independent — an RM can have any
// combination (e.g. specific societies AND a fallback micro-market). Empty
// arrays mean "no scope at that level"; one level being set never clears
// another. Assignment matches society first, then micro-market.
const SCOPE_LEVELS = [
  { key: 'city',         label: 'City',         field: 'cities' },
  { key: 'micro_market', label: 'Micro-market', field: 'micro_market' },
  { key: 'society',      label: 'Society',      field: 'society' },
];

export default function UserEditModal({ user, managers, areas, onClose, onSaved }) {
  const [cities, setCities] = useState(user.cities || []);
  const [microMarkets, setMicroMarkets] = useState(user.micro_market || []);
  const [societies, setSocieties] = useState(user.society || []);
  const [manager, setManager] = useState(user.manager || '');
  const [isActive, setIsActive] = useState(!!user.is_active);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const valueFor = { city: cities, micro_market: microMarkets, society: societies };
  const setterFor = { city: setCities, micro_market: setMicroMarkets, society: setSocieties };
  const optionsFor = {
    city: areas.cities || [],
    micro_market: areas.micro_markets || [],
    society: areas.societies || [],
  };

  async function save() {
    setError(null);
    setSaving(true);
    try {
      // Every scope level is sent independently. Setting society no longer
      // wipes micro-market (and vice versa) — both can apply for the same RM.
      const body = {
        is_active: isActive,
        manager: manager ? Number(manager) : null,
        cities,
        micro_market: microMarkets,
        society: societies,
      };
      const r = await api.patch(`/api/users/${user.id}`, body);
      onSaved(r);
    } catch (e) {
      setError(e.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-user-edit" onClick={(e) => e.stopPropagation()}>
        <div className="card-detail-head">
          <div className="card-detail-title">
            <strong>{user.name || user.email}</strong>
            <span className="role-chip">{user.role}</span>
            <span className="oh-id">{user.email}</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ue-section">
          <label className="ue-label">Status</label>
          <label className="ue-toggle">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            <span>{isActive ? 'Active' : 'Inactive'}</span>
          </label>
        </div>

        <div className="ue-section">
          <label className="ue-label">Manager</label>
          <select
            className="ue-manager-select role-select"
            value={manager}
            onChange={(e) => setManager(e.target.value)}
          >
            <option value="">— none —</option>
            {managers
              .filter((m) => m.id !== user.id)
              .map((m) => (
                <option key={m.id} value={m.id}>{m.name || m.email}</option>
              ))}
          </select>
        </div>

        <div className="ue-section">
          <label className="ue-label">Area scope</label>
          <p className="ue-hint">
            Set any combination. Assignment matches by society first, then falls
            back to micro-market via the society → micro-market mapping. City is
            used for manager visibility only.
          </p>
          <div className="ue-scope-grid">
            {SCOPE_LEVELS.map((lvl) => (
              <div key={lvl.key} className="ue-scope-col ue-scope-active">
                <label className="ue-scope-head">
                  {lvl.label}
                  <span className="ue-scope-count">
                    {valueFor[lvl.key].length || ''}
                  </span>
                </label>
                <SearchableMultiSelect
                  options={optionsFor[lvl.key]}
                  value={valueFor[lvl.key]}
                  onChange={setterFor[lvl.key]}
                  placeholder={`Select ${lvl.label.toLowerCase()}…`}
                />
              </div>
            ))}
          </div>
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
