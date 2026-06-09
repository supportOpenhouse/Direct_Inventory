import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import ExpandPanel from '../components/ExpandPanel.jsx';
import FilterPanel from '../components/FilterPanel.jsx';
import {
  CITIES, displayCity, isCreatedToday, rejectReasonsForStage, starColor,
} from '../utils/format.js';
import { IconExternal, IconFilter, IconSearch } from '../components/icons.jsx';

// Notes intentionally dropped from the Leads expand panel.
const EXPAND_SECTIONS = ['property', 'seller'];

// ── star cell (priority toggle) ──────────────────────────────────────────
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

// ── generic action table — used for both the Lead and Active Lead panes ────
// primaryMode 'direct' fires onPrimary(item) immediately; 'phone' opens an
// inline [number] [save] [cancel] editor over the action cell and fires
// onPrimary(item, phone) on save (used by Active → Qualify, which captures the
// seller's number first).
function ActionTable({ items, loading, role, onUpdated, primaryLabel, primaryMode = 'direct', onPrimary, onReject, reasons, emptyText, isNew = () => false }) {
  const [openId, setOpenId] = useState(null);
  const [rejectFor, setRejectFor] = useState(null);
  const [phoneFor, setPhoneFor] = useState(null);
  const [phoneVal, setPhoneVal] = useState('');
  const canSet = ['admin', 'manager', 'rm'].includes(role);
  const cols = 4;
  const link = (it) => (it.listing_link && !/^internal:\/\//.test(it.listing_link) ? it.listing_link : null);
  const phoneMode = primaryMode === 'phone';

  function startPrimary(it) {
    if (!phoneMode) { onPrimary(it); return; }
    setRejectFor(null);
    if (phoneFor === it.oh_id) { setPhoneFor(null); return; }
    // Prefill the existing number, normalised to the app's 10-digit convention.
    setPhoneVal((it.seller_phone || '').replace(/\D/g, '').slice(0, 10));
    setPhoneFor(it.oh_id);
  }
  function savePhone(it) {
    const v = phoneVal.trim();
    if (v.length !== 10) return; // require a complete 10-digit number to qualify
    setPhoneFor(null);
    onPrimary(it, v);
  }

  return (
    <div className="inv-table-wrap">
      <table className="inv-table">
        <thead>
          <tr>
            <th className="inv-th inv-th-star" />
            <th className="inv-th">Society</th>
            <th className="inv-th">Link</th>
            <th className="inv-th">Action</th>
          </tr>
        </thead>
        <tbody>
          {loading && Array.from({ length: 6 }).map((_, r) => (
            <tr className="inv-row" key={`s${r}`}>{Array.from({ length: cols }).map((__, c) => <td key={c}><span className="inv-skel" /></td>)}</tr>
          ))}
          {!loading && items.length === 0 && <tr><td className="inv-empty" colSpan={cols}>{emptyText}</td></tr>}
          {!loading && items.map((it) => {
            const isOpen = openId === it.oh_id;
            return (
              <Fragment key={it.oh_id}>
                <tr className={`inv-row ${isOpen ? 'inv-row-open' : ''}`} onClick={() => setOpenId(isOpen ? null : it.oh_id)}>
                  <StarCell item={it} canSet={canSet} onUpdated={onUpdated} />
                  <td className="inv-td-society">
                    {it.society || '—'}
                    {isNew(it) && <img className="new-badge-img" src="/new.png" alt="NEW" />}
                    <div className="inv-td-muted" style={{ fontWeight: 400, fontSize: 12 }}>{displayCity(it.city)} · {it.oh_id}</div>
                  </td>
                  <td>
                    {link(it)
                      ? <a className="inv-link" href={link(it)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Listing <IconExternal size={12} /></a>
                      : <span className="muted">—</span>}
                  </td>
                  <td style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                    <div className="lead-actions">
                      <button className="lead-act-q" onClick={() => startPrimary(it)}>{primaryLabel}</button>
                      <button className="lead-act-r" onClick={() => { setPhoneFor(null); setRejectFor(rejectFor === it.oh_id ? null : it.oh_id); }}>Reject ▾</button>
                    </div>
                    {rejectFor === it.oh_id && (
                      <div className={`reject-menu ${phoneMode ? 'reject-menu-sm' : ''}`} onMouseLeave={() => setRejectFor(null)}>
                        <div className="rm-title">Reject reason</div>
                        {reasons.map((r) => (
                          <button key={r.value} onClick={() => { setRejectFor(null); onReject(it, r.value); }}>{r.label}</button>
                        ))}
                      </div>
                    )}
                    {phoneMode && phoneFor === it.oh_id && (
                      <div className="phone-entry">
                        <input
                          autoFocus type="tel" inputMode="numeric" maxLength={10}
                          value={phoneVal}
                          onChange={(e) => setPhoneVal(e.target.value.replace(/\D/g, '').slice(0, 10))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); savePhone(it); }
                            else if (e.key === 'Escape') { e.preventDefault(); setPhoneFor(null); }
                          }}
                          placeholder="10-digit no." />
                        <button className="pe-save" disabled={phoneVal.trim().length !== 10} onClick={() => savePhone(it)}>Save</button>
                        <button className="pe-cancel" onClick={() => setPhoneFor(null)}>Cancel</button>
                      </div>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="expand-row"><td colSpan={cols}>
                    <ExpandPanel item={it} role={role} onUpdated={onUpdated} canPost={canSet} sections={EXPAND_SECTIONS} />
                  </td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Leads() {
  const { user } = useAuth();
  const [qInput, setQInput] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [city, setCity] = useState('');
  const [leads, setLeads] = useState([]);
  const [active, setActive] = useState([]);
  const [loadingL, setLoadingL] = useState(true);
  const [loadingR, setLoadingR] = useState(true);
  const [filtersApplied, setFiltersApplied] = useState({});
  const [filterFormState, setFilterFormState] = useState({});
  const [showFilters, setShowFilters] = useState(false);
  const filterCount = Object.keys(filtersApplied).length;

  // which pane(s) to show: 'lead' | 'both' | 'active'
  const [paneView, setPaneView] = useState('both');
  const [leftPct, setLeftPct] = useState(50);
  const containerRef = useRef(null);
  const draggingRef = useRef(false);

  function baseParams(stage) {
    const p = new URLSearchParams();
    p.set('stage', stage);
    if (qApplied) p.set('q', qApplied);
    if (city) p.set('city', city);
    for (const [k, v] of Object.entries(filtersApplied)) p.set(k, String(v));
    p.set('limit', '500');
    return p;
  }

  const loadLeads = useCallback(async () => {
    setLoadingL(true);
    try { const r = await api.get(`/api/inventory?${baseParams('lead')}`); setLeads(r.items || []); }
    finally { setLoadingL(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qApplied, city, filtersApplied]);

  const loadActive = useCallback(async () => {
    setLoadingR(true);
    try {
      const p = baseParams('active');
      p.set('annotate_active_today', '1'); // stamps active_today → "NEW" badge
      const r = await api.get(`/api/inventory?${p}`);
      setActive(r.items || []);
    } finally { setLoadingR(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qApplied, city, filtersApplied]);

  useEffect(() => { loadLeads(); loadActive(); }, [loadLeads, loadActive]);

  const onDrag = useCallback((e) => {
    if (!draggingRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setLeftPct(Math.min(75, Math.max(25, pct)));
  }, []);
  useEffect(() => {
    function up() { draggingRef.current = false; document.body.style.cursor = ''; }
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', onDrag); window.removeEventListener('mouseup', up); };
  }, [onDrag]);

  function patch(setter) {
    return (updated) => setter((prev) => prev.map((it) => (it.oh_id === updated.oh_id ? { ...it, ...updated } : it)));
  }

  // lead → active. Activating today = "new" in the Active pane, so stamp
  // active_today optimistically for an immediate NEW badge.
  async function activate(item) {
    setLeads((prev) => prev.filter((it) => it.oh_id !== item.oh_id));
    setActive((prev) => [{ ...item, stage: 'active', active_today: true }, ...prev]);
    try { await api.patch(`/api/inventory/${item.oh_id}`, { stage: 'active' }); }
    catch { loadLeads(); loadActive(); }
  }
  // active → qualified (moves to the Qualified Leads page). Captures the
  // seller's phone first; saving it auto-advances the lead to qualified.
  async function qualify(item, phone) {
    setActive((prev) => prev.filter((it) => it.oh_id !== item.oh_id));
    const body = { stage: 'qualified' };
    if (phone && phone !== item.seller_phone) body.seller_phone = phone;
    try { await api.patch(`/api/inventory/${item.oh_id}`, body); }
    catch { loadActive(); }
  }
  async function rejectLead(item, reason) {
    setLeads((prev) => prev.filter((it) => it.oh_id !== item.oh_id));
    try { await api.patch(`/api/inventory/${item.oh_id}`, { stage: 'rejected', stage_reason: reason }); }
    catch { loadLeads(); }
  }
  async function rejectActive(item, reason) {
    setActive((prev) => prev.filter((it) => it.oh_id !== item.oh_id));
    try { await api.patch(`/api/inventory/${item.oh_id}`, { stage: 'rejected', stage_reason: reason }); }
    catch { loadActive(); }
  }

  function onSearch(e) { e.preventDefault(); setQApplied(qInput.trim()); }

  return (
    <div className="leads-page">
      <div className="leads-toolbar">
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
        <div className="view-toggle">
          <button className={paneView === 'lead' ? 'on' : ''} onClick={() => setPaneView('lead')}>Lead</button>
          <button className={paneView === 'both' ? 'on' : ''} onClick={() => setPaneView('both')}>Both</button>
          <button className={paneView === 'active' ? 'on' : ''} onClick={() => setPaneView('active')}>Active</button>
        </div>
      </div>

      <div className="leads-split" ref={containerRef}>
        {paneView !== 'active' && (
          <div className="leads-pane" style={{ width: paneView === 'both' ? `calc(${leftPct}% - 7px)` : '100%' }}>
            <div className="leads-pane-head">
              <h3>Leads</h3>
              <span className="lph-count accent">{leads.length}</span>
              <span className="muted" style={{ fontSize: 12 }}>status: lead</span>
            </div>
            <ActionTable items={leads} loading={loadingL} role={user?.role} onUpdated={patch(setLeads)}
              primaryLabel="Active" onPrimary={activate} onReject={rejectLead}
              reasons={rejectReasonsForStage('lead')} emptyText="No leads."
              isNew={(it) => isCreatedToday(it.created_at)} />
          </div>
        )}

        {paneView === 'both' && (
          <div className={`split-divider ${draggingRef.current ? 'dragging' : ''}`}
            onMouseDown={() => { draggingRef.current = true; document.body.style.cursor = 'col-resize'; }}
            role="separator" aria-label="Resize panes">
            <span className="sd-grip" />
          </div>
        )}

        {paneView !== 'lead' && (
          <div className="leads-pane" style={{ width: paneView === 'both' ? `calc(${100 - leftPct}% - 7px)` : '100%' }}>
            <div className="leads-pane-head">
              <h3>Active Leads</h3>
              <span className="lph-count">{active.length}</span>
              <span className="muted" style={{ fontSize: 12 }}>status: active</span>
            </div>
            <ActionTable items={active} loading={loadingR} role={user?.role} onUpdated={patch(setActive)}
              primaryLabel="Add Phone No." primaryMode="phone" onPrimary={qualify} onReject={rejectActive}
              reasons={rejectReasonsForStage('active')} emptyText="No active leads."
              isNew={(it) => !!it.active_today} />
          </div>
        )}
      </div>

      {showFilters && (
        <FilterPanel initial={filterFormState} defaultCity={city} role={user?.role}
          onClose={() => setShowFilters(false)}
          onApply={(applied, form) => { setFiltersApplied(applied); setFilterFormState(form); setShowFilters(false); }} />
      )}
    </div>
  );
}
