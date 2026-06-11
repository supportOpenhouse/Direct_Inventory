import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import ExpandPanel from '../components/ExpandPanel.jsx';
import FilterPanel from '../components/FilterPanel.jsx';
import OhPrice from '../components/OhPrice.jsx';
import { CITIES, displayCity, formatPrice, starColor, variation } from '../utils/format.js';
import { IconFilter, IconSearch } from '../components/icons.jsx';

function formatAssignedRms(rms) {
  if (!Array.isArray(rms) || rms.length === 0) return '—';
  const first = rms[0];
  const label = first.name || first.email || `#${first.id}`;
  const extra = rms.length - 1;
  return extra > 0 ? `${label} +${extra}` : label;
}
function assignedRmsTitle(rms) {
  if (!Array.isArray(rms) || rms.length === 0) return '';
  return rms.map((r) => r.name || r.email || `#${r.id}`).join(', ');
}

function StarCell({ item, canSet, onUpdated }) {
  const color = starColor(item);
  if (!color && !canSet) return <td className="inv-td-star" />;
  async function toggle(e) {
    e.stopPropagation();
    if (!canSet) return;
    const wantYellow = color !== 'yellow';
    const body = wantYellow ? { star_color: 'yellow', priority: true } : { star_color: null, priority: false };
    onUpdated({ ...item, ...body });
    try { const r = await api.patch(`/api/inventory/${item.oh_id}`, body); if (r?.item) onUpdated(r.item); }
    catch { onUpdated(item); }
  }
  return (
    <td className="inv-td-star">
      <button type="button" disabled={!canSet}
        className={`prio-star ${color === 'yellow' ? 'prio-on' : color === 'green' ? 'cp-perfect' : color === 'red' ? 'cp-partial' : 'prio-off'}`}
        onClick={toggle} title="Priority">★</button>
    </td>
  );
}

// Qualified Leads — same flow as the old qualified table: a detail view of
// qualified leads with the expand panel (status edit + notes) for next steps.
export default function QualifiedLeads() {
  const { user } = useAuth();
  const [qInput, setQInput] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [city, setCity] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [filtersApplied, setFiltersApplied] = useState({});
  const [filterFormState, setFilterFormState] = useState({});
  const [showFilters, setShowFilters] = useState(false);
  const canPost = ['admin', 'manager', 'rm'].includes(user?.role);
  const isAdmin = user?.role === 'admin';
  const cols = isAdmin ? 9 : 8;
  const filterCount = Object.keys(filtersApplied).length;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set('stage', 'qualified');
      p.set('annotate_qualified_today', '1'); // stamps qualified_today → "NEW" badge
      if (qApplied) p.set('q', qApplied);
      if (city) p.set('city', city);
      for (const [k, v] of Object.entries(filtersApplied)) p.set(k, String(v));
      p.set('limit', '500');
      const r = await api.get(`/api/inventory?${p}`);
      setItems(r.items || []);
    } finally { setLoading(false); }
  }, [qApplied, city, filtersApplied]);

  useEffect(() => { load(); }, [load]);

  // The Add Inventory button lives in the global topbar; refetch when it adds.
  useEffect(() => {
    const onAdded = () => load();
    window.addEventListener('inventory:added', onAdded);
    return () => window.removeEventListener('inventory:added', onAdded);
  }, [load]);

  function patchItem(updated) { setItems((prev) => prev.map((it) => (it.oh_id === updated.oh_id ? { ...it, ...updated } : it))); }
  function onSearch(e) { e.preventDefault(); setQApplied(qInput.trim()); }

  return (
    <div>
      <div className="toolbar">
        <div className="city-tabs">
          <button className={!city ? 'tab tab-active' : 'tab'} onClick={() => setCity('')}>All</button>
          {CITIES.map((c) => <button key={c} className={city === c ? 'tab tab-active' : 'tab'} onClick={() => setCity(c)}>{c}</button>)}
        </div>
        <form className="search-form" onSubmit={onSearch}>
          <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search any field — e.g. 1003 D2 Sahaj" />
          <button type="submit" className="btn-primary"><IconSearch size={16} /> Search</button>
          {qApplied && <button type="button" className="btn-ghost" onClick={() => { setQInput(''); setQApplied(''); }}>Clear</button>}
        </form>
        <button className="btn-ghost" onClick={() => setShowFilters(true)}><IconFilter size={16} /> Filters{filterCount ? ` (${filterCount})` : ''}</button>
        {filterCount > 0 && <button className="btn-link" onClick={() => { setFiltersApplied({}); setFilterFormState({}); }}>Reset</button>}
        <div className="toolbar-spacer" />
        <span className="muted" style={{ fontSize: 13 }}>{items.length} qualified</span>
      </div>

      <div className="inv-table-wrap">
        <table className="inv-table">
          <thead>
            <tr>
              <th className="inv-th inv-th-star" />
              <th className="inv-th">Society</th>
              <th className="inv-th">BHK</th>
              <th className="inv-th">Floor</th>
              <th className="inv-th">Area</th>
              <th className="inv-th inv-th-right">Asking</th>
              <th className="inv-th inv-th-right">OH Price</th>
              <th className="inv-th inv-th-right">Variation</th>
              {isAdmin && <th className="inv-th">RM</th>}
            </tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 8 }).map((_, r) => (
              <tr className="inv-row" key={`s${r}`}>{Array.from({ length: cols }).map((__, c) => <td key={c}><span className="inv-skel" /></td>)}</tr>
            ))}
            {!loading && items.length === 0 && <tr><td className="inv-empty" colSpan={cols}>No qualified leads.</td></tr>}
            {!loading && items.map((it) => {
              const isOpen = openId === it.oh_id;
              const v = variation(it.price, it.oh_price);
              return (
                <Fragment key={it.oh_id}>
                  <tr className={`inv-row ${isOpen ? 'inv-row-open' : ''}`} onClick={() => setOpenId(isOpen ? null : it.oh_id)}>
                    <StarCell item={it} canSet={canPost} onUpdated={patchItem} />
                    <td className="inv-td-society">{it.society || '—'}{it.qualified_today && <img className="new-badge-img" src="/new.png" alt="NEW" />}<div className="inv-td-muted" style={{ fontWeight: 400, fontSize: 12 }}>{displayCity(it.city)} · {it.oh_id}</div></td>
                    <td>{it.bedrooms != null ? `${it.bedrooms} BHK` : '—'}</td>
                    <td>{it.floor || '—'}</td>
                    <td>{it.area_sqft != null ? `${it.area_sqft} sqft` : '—'}</td>
                    <td className="inv-td-num val-orange">{formatPrice(it.price)}</td>
                    <td className="inv-td-num"><OhPrice item={it} /></td>
                    <td className={`inv-td-num ${v ? `val-var-${v.sign}` : 'muted'}`}>{v ? v.label : '—'}</td>
                    {isAdmin && <td className="inv-td-muted" title={assignedRmsTitle(it.assigned_rms)}><span className="inv-clip inv-clip-rm">{formatAssignedRms(it.assigned_rms)}</span></td>}
                  </tr>
                  {isOpen && (
                    <tr className="expand-row"><td colSpan={cols}>
                      <ExpandPanel item={it} role={user?.role} onUpdated={patchItem} canPost={canPost} />
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {showFilters && (
        <FilterPanel initial={filterFormState} defaultCity={city} role={user?.role}
          onClose={() => setShowFilters(false)}
          onApply={(applied, form) => { setFiltersApplied(applied); setFilterFormState(form); setShowFilters(false); }} />
      )}
    </div>
  );
}
