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

// Per-pane page size — "Load more" appends the next page.
const PAGE_SIZE = 50;

// Append a page, dropping rows already present (optimistic moves shift server
// offsets, which would otherwise duplicate keys).
function appendPage(prev, items) {
  const seen = new Set(prev.map((it) => it.oh_id));
  return [...prev, ...items.filter((it) => !seen.has(it.oh_id))];
}

// The original starburst badge — new.png is now a 60×60 (~5 KB) asset sized
// for its 20px render (3× DPR headroom), so shipping the image is cheap.
function NewBadge() {
  return <img className="new-badge-img" src="/new.png" alt="NEW" />;
}

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
                    {isNew(it) && <NewBadge />}
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
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [activeTotal, setActiveTotal] = useState(0);
  const [loadingL, setLoadingL] = useState(true);
  const [loadingR, setLoadingR] = useState(true);
  const [moreL, setMoreL] = useState(false);
  const [moreR, setMoreR] = useState(false);
  const [filtersApplied, setFiltersApplied] = useState({});
  const [filterFormState, setFilterFormState] = useState({});
  const [showFilters, setShowFilters] = useState(false);
  const filterCount = Object.keys(filtersApplied).length;

  // which pane(s) to show: 'lead' | 'both' | 'active'
  const [paneView, setPaneView] = useState('both');
  const [leftPct, setLeftPct] = useState(50);
  const containerRef = useRef(null);
  const draggingRef = useRef(false);

  function baseParams(stage, offset) {
    const p = new URLSearchParams();
    p.set('stage', stage);
    if (qApplied) p.set('q', qApplied);
    if (city) p.set('city', city);
    for (const [k, v] of Object.entries(filtersApplied)) p.set(k, String(v));
    p.set('limit', String(PAGE_SIZE));
    p.set('offset', String(offset));
    return p;
  }

  // The list ships without the active_today annotation (cheap query); the
  // "NEW" badges hydrate afterwards from /badges and merge into the rows.
  async function hydrateActiveBadges(items) {
    const ids = items.map((it) => it.oh_id).filter(Boolean);
    if (!ids.length) return;
    try {
      const r = await api.get(`/api/inventory/badges?ids=${ids.join(',')}&flags=active_today`);
      const badges = r?.badges || {};
      setActive((prev) => prev.map((it) => (badges[it.oh_id] ? { ...it, active_today: !!badges[it.oh_id].active_today } : it)));
    } catch { /* badges are cosmetic — leave rows un-stamped on failure */ }
  }

  // offset 0 replaces the pane (fresh load / filter change); a positive offset
  // appends the next page ("Load more").
  const loadLeads = useCallback(async (offset = 0) => {
    const setBusy = offset ? setMoreL : setLoadingL;
    setBusy(true);
    try {
      const r = await api.get(`/api/inventory?${baseParams('lead', offset)}`);
      const items = r.items || [];
      setLeads((prev) => (offset ? appendPage(prev, items) : items));
      setLeadsTotal(r.total ?? items.length);
    } finally { setBusy(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qApplied, city, filtersApplied]);

  const loadActive = useCallback(async (offset = 0) => {
    const setBusy = offset ? setMoreR : setLoadingR;
    setBusy(true);
    try {
      const r = await api.get(`/api/inventory?${baseParams('active', offset)}`);
      const items = r.items || [];
      setActive((prev) => (offset ? appendPage(prev, items) : items));
      setActiveTotal(r.total ?? items.length);
      hydrateActiveBadges(items); // async "NEW" stamp — don't block the rows
    } finally { setBusy(false); }
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
    setLeadsTotal((t) => Math.max(0, t - 1));
    setActive((prev) => [{ ...item, stage: 'active', active_today: true }, ...prev]);
    setActiveTotal((t) => t + 1);
    try { await api.patch(`/api/inventory/${item.oh_id}`, { stage: 'active' }); }
    catch { loadLeads(); loadActive(); }
  }
  // active → qualified (moves to the Qualified Leads page). Captures the
  // seller's phone first; saving it auto-advances the lead to qualified.
  async function qualify(item, phone) {
    setActive((prev) => prev.filter((it) => it.oh_id !== item.oh_id));
    setActiveTotal((t) => Math.max(0, t - 1));
    const body = { stage: 'qualified' };
    if (phone && phone !== item.seller_phone) body.seller_phone = phone;
    try { await api.patch(`/api/inventory/${item.oh_id}`, body); }
    catch { loadActive(); }
  }
  async function rejectLead(item, reason) {
    setLeads((prev) => prev.filter((it) => it.oh_id !== item.oh_id));
    setLeadsTotal((t) => Math.max(0, t - 1));
    try { await api.patch(`/api/inventory/${item.oh_id}`, { stage: 'rejected', stage_reason: reason }); }
    catch { loadLeads(); }
  }
  async function rejectActive(item, reason) {
    setActive((prev) => prev.filter((it) => it.oh_id !== item.oh_id));
    setActiveTotal((t) => Math.max(0, t - 1));
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
              <span className="lph-count accent">{leadsTotal}</span>
              <span className="muted" style={{ fontSize: 12 }}>status: lead</span>
            </div>
            <ActionTable items={leads} loading={loadingL} role={user?.role} onUpdated={patch(setLeads)}
              primaryLabel="Active" onPrimary={activate} onReject={rejectLead}
              reasons={rejectReasonsForStage('lead')} emptyText="No leads."
              isNew={(it) => isCreatedToday(it.created_at)} />
            {!loadingL && leads.length < leadsTotal && (
              <button className="btn-ghost" style={{ display: 'block', margin: '10px auto' }}
                disabled={moreL} onClick={() => loadLeads(leads.length)}>
                {moreL ? 'Loading…' : `Load more (${leads.length} of ${leadsTotal})`}
              </button>
            )}
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
              <span className="lph-count">{activeTotal}</span>
              <span className="muted" style={{ fontSize: 12 }}>status: active</span>
            </div>
            <ActionTable items={active} loading={loadingR} role={user?.role} onUpdated={patch(setActive)}
              primaryLabel="Add Phone No." primaryMode="phone" onPrimary={qualify} onReject={rejectActive}
              reasons={rejectReasonsForStage('active')} emptyText="No active leads."
              isNew={(it) => !!it.active_today} />
            {!loadingR && active.length < activeTotal && (
              <button className="btn-ghost" style={{ display: 'block', margin: '10px auto' }}
                disabled={moreR} onClick={() => loadActive(active.length)}>
                {moreR ? 'Loading…' : `Load more (${active.length} of ${activeTotal})`}
              </button>
            )}
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
