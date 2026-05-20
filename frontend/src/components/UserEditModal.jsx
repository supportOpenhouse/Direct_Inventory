import { useState } from 'react';
import { api } from '../api/client.js';
import SearchableMultiSelect from './SearchableMultiSelect.jsx';

// The three scope levels, in resolution-precedence order (society wins, then
// micro-market, then city). An RM is scoped by exactly ONE level — the other
// two are stored empty.
const SCOPE_LEVELS = [
  { key: 'city',         label: 'City' },
  { key: 'micro_market', label: 'Micro-market' },
  { key: 'society',      label: 'Society' },
];

function initialScope(user) {
  if ((user.society || []).length) return 'society';
  if ((user.micro_market || []).length) return 'micro_market';
  return 'city';
}

export default function UserEditModal({ user, managers, areas, onClose, onSaved }) {
  const [scope, setScope] = useState(() => initialScope(user));
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
      // Only the active scope level is persisted with values; the other two
      // are explicitly cleared so the precedence logic stays unambiguous.
      const body = {
        is_active: isActive,
        manager: manager ? Number(manager) : null,
        cities:       scope === 'city'         ? cities       : [],
        micro_market: scope === 'micro_market' ? microMarkets : [],
        society:      scope === 'society'      ? societies    : [],
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
            Choose <strong>one</strong> level. Visibility resolves society → micro-market
            → city; the other two levels are cleared on save.
          </p>
          <div className="ue-scope-grid">
            {SCOPE_LEVELS.map((lvl) => {
              const active = scope === lvl.key;
              return (
                <div key={lvl.key} className={`ue-scope-col ${active ? 'ue-scope-active' : ''}`}>
                  <label className="ue-scope-head">
                    <input
                      type="radio"
                      name="scope-level"
                      checked={active}
                      onChange={() => setScope(lvl.key)}
                    />
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
                    disabled={!active}
                  />
                </div>
              );
            })}
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
