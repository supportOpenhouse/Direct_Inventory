import { Fragment, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { CITIES, STAGE_DOT_COLOR, STAGES, stageLabel } from '../utils/format.js';
import InventoryTable from './InventoryTable.jsx';
import FilterPanel from './FilterPanel.jsx';
import AddInventoryModal from './AddInventoryModal.jsx';
import BulkActionBar from './BulkActionBar.jsx';
import { IconFilter, IconPlus, IconReload, IconSearch } from './icons.jsx';

const PAGE_SIZE = 50;

/**
 * The classic board experience: city tabs, search, filters, stage count pills,
 * pagination and the expandable inventory table. Reused by Home's Table view
 * and (scoped) by stage-specific pages.
 *
 * `fixedStages` pins the view to a stage set and hides the stage pills (e.g.
 * the Rejected page). `showAdd` toggles the add-inventory button.
 */
export default function InventoryBoard({
  fixedStages = null, showAdd = true, stageFilterable = true, toolbarExtra = null,
  allowStatusEdit = true, reasonFilter = false, hideFollowUpFilter = false, reasonOptions = undefined,
  reloadSignal = 0, onReload = null, extraStageGroups = [], annotateVisitOverdue = false,
  showReasonCol = false, showExport = false,
}) {
  const { user } = useAuth();
  const [qInput, setQInput] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [city, setCity] = useState('');
  // Default to "ALL" selected (empty set → effectiveStages falls back to the
  // fixed stage set), so no individual stage pill is pre-selected.
  const [stageSel, setStageSel] = useState(() => new Set());
  const [sort, setSort] = useState({ field: 'smart', dir: 'desc' });
  const [page, setPage] = useState(0);
  const [pageInput, setPageInput] = useState('1');

  const [filtersApplied, setFiltersApplied] = useState({});
  const [filterFormState, setFilterFormState] = useState({});
  const [showFilters, setShowFilters] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({ total: 0, by_stage: {} });

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [selectingAll, setSelectingAll] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const stages = fixedStages || STAGES;

  function makeParams() {
    const p = new URLSearchParams();
    if (qApplied) p.set('q', qApplied);
    if (city) p.set('city', city);
    // ALL (nothing selected) restricts to THIS board's own stages — so grouped
    // extras like Post Visit (Supply Closure stages) only show when their pill
    // is explicitly selected, never in the default view or other stage pills.
    const effectiveStages = stageSel.size > 0 ? Array.from(stageSel) : stages;
    if (effectiveStages.length) p.set('stage', effectiveStages.join(','));
    if (sort.field) { p.set('sort', sort.field); p.set('dir', sort.dir); }
    if (annotateVisitOverdue) p.set('annotate_visit_overdue', '1');
    for (const [k, v] of Object.entries(filtersApplied)) p.set(k, String(v));
    return p;
  }

  async function refresh(cur = page) {
    setLoading(true);
    try {
      const params = makeParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(cur * PAGE_SIZE));
      const r = await api.get(`/api/inventory?${params}`);
      setItems(r.items); setTotal(r.total);
    } finally { setLoading(false); }
  }
  async function refreshCounts() {
    try {
      const params = makeParams();
      params.delete('stage'); // counts are per-stage
      const r = await api.get(`/api/inventory/counts?${params}`);
      setCounts(r);
    } catch { /* non-blocking */ }
  }

  useEffect(() => { setPage(0); refresh(0); refreshCounts(); /* eslint-disable-next-line */ }, [city, qApplied, stageSel, filtersApplied, sort.field, sort.dir]);
  useEffect(() => { refresh(page); /* eslint-disable-next-line */ }, [page]);
  // Keep the editable page box in sync with the actual page (Prev/Next/reset).
  useEffect(() => { setPageInput(String(page + 1)); }, [page]);
  // External reload trigger (e.g. the tracker's auto-sync finished).
  useEffect(() => { if (reloadSignal) { refresh(page); refreshCounts(); } /* eslint-disable-next-line */ }, [reloadSignal]);

  function onSearch(e) { e?.preventDefault(); setQApplied(qInput.trim()); }
  function toggleStage(s) {
    setStageSel((prev) => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  }
  function patchItem(updated) { setItems((prev) => prev.map((it) => (it.oh_id === updated.oh_id ? { ...it, ...updated } : it))); }

  function toggleSelect(oh_id) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(oh_id)) n.delete(oh_id); else n.add(oh_id); return n; });
  }
  function toggleSelectAll(visibleIds) {
    if (!visibleIds || visibleIds.length === 0) return;
    setSelected((prev) => {
      const allChecked = visibleIds.every((id) => prev.has(id));
      const n = new Set(prev);
      if (allChecked) visibleIds.forEach((id) => n.delete(id));
      else visibleIds.forEach((id) => n.add(id));
      return n;
    });
  }
  // Select EVERY row matching the current filter/search/stage — across all
  // pages, not just the visible 50. Fetches all matching oh_ids in one go.
  async function selectAllMatching() {
    if (total <= 0) return;
    try {
      setSelectingAll(true);
      // ids-only endpoint — no 1000-row list cap, so all matching rows select.
      const r = await api.get(`/api/inventory/ids?${makeParams()}`);
      setSelected(new Set(r.ids || []));
      if (r.capped) alert(`Selection capped at ${(r.ids || []).length} rows.`);
    } catch (e) {
      alert('Select all failed: ' + (e?.data?.error || e?.message || e));
    } finally { setSelectingAll(false); }
  }
  // Download all rows matching the current filters/scope as CSV (not just this
  // page) — the backend export honors the same params makeParams() builds.
  async function downloadCsv() {
    try {
      setDownloading(true);
      const blob = await api.download(`/api/inventory/export?${makeParams()}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inventory_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Download failed: ' + (e?.data?.error || e?.message || e));
    } finally { setDownloading(false); }
  }
  // Jump to a typed page number, clamped to [1, totalPages].
  function goToPage() {
    const n = parseInt(pageInput, 10);
    if (Number.isNaN(n)) { setPageInput(String(page + 1)); return; }
    const clamped = Math.min(totalPages, Math.max(1, n));
    setPage(clamped - 1);
    setPageInput(String(clamped));
  }
  function exitSelectMode() { setSelectMode(false); setSelected(new Set()); }
  function onBulkDone(result) {
    exitSelectMode();
    refresh(page);
    refreshCounts();
    if (result?.skipped_forbidden?.length || result?.not_found?.length) {
      alert(
        `Updated ${result.updated} of ${result.requested}.\n`
        + (result.skipped_forbidden?.length ? `Forbidden (not yours): ${result.skipped_forbidden.length}\n` : '')
        + (result.not_found?.length ? `Not found: ${result.not_found.length}` : ''),
      );
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filterCount = Object.keys(filtersApplied).length;
  // "ALL" means all of THIS board's own stages — sum their counts. Grouped
  // extras (e.g. Post Visit) are NOT included, matching the ALL stage filter.
  const allCount = stages.reduce((a, s) => a + (counts.by_stage?.[s] || 0), 0);

  // A "grouped" count pill (e.g. Post Visit = all supply stages combined).
  function groupPill(g) {
    const cnt = g.stages.reduce((a, st) => a + (counts.by_stage?.[st] || 0), 0);
    const active = g.stages.length > 0 && g.stages.every((st) => stageSel.has(st)) && stageSel.size === g.stages.length;
    return (
      <button key={g.key} type="button" className={active ? 'count-pill count-pill-active' : 'count-pill'}
        onClick={() => setStageSel(active ? new Set() : new Set(g.stages))}>
        <div className="num" style={{ color: g.color }}>{cnt}</div>
        <div className="lbl">{g.label.toUpperCase()}</div>
      </button>
    );
  }

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
        {showAdd && <button className="btn-primary" onClick={() => setShowAddModal(true)}><IconPlus size={16} /> Add Inventory</button>}
        <div className="toolbar-spacer" />
        {showExport && (
          <button className="btn-ghost" onClick={downloadCsv} disabled={downloading || total === 0}>
            {downloading ? 'Preparing…' : `Download CSV${total ? ` (${total})` : ''}`}
          </button>
        )}
        <button className={selectMode ? 'btn-primary' : 'btn-ghost'} onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}>
          {selectMode ? 'Exit Select' : 'Select'}
        </button>
        {toolbarExtra}
      </div>

      {/* Floats to the top-right of the page (see .bulk-bar) while selecting. */}
      {selectMode && selected.size > 0 && (
        <BulkActionBar selected={selected} role={user?.role} onCleared={exitSelectMode} onDone={onBulkDone} />
      )}

      {stageFilterable && (
        <div className="stage-counts">
          <div className="stage-pills">
            <button type="button" className={stageSel.size === 0 ? 'count-pill count-pill-active' : 'count-pill'} onClick={() => setStageSel(new Set())}>
              <div className="num">{allCount}</div><div className="lbl">ALL</div>
            </button>
            {stages.map((s) => (
              <Fragment key={s}>
                {extraStageGroups.filter((g) => g.before === s).map(groupPill)}
                <button type="button" className={stageSel.has(s) ? 'count-pill count-pill-active' : 'count-pill'} onClick={() => toggleStage(s)}>
                  <div className="num" style={{ color: STAGE_DOT_COLOR[s] }}>{counts.by_stage?.[s] ?? 0}</div>
                  <div className="lbl">{stageLabel(s).toUpperCase()}</div>
                </button>
              </Fragment>
            ))}
            {extraStageGroups.filter((g) => !g.before).map(groupPill)}
          </div>
        </div>
      )}

      <div className="filtered-header">
        <span className="muted">Showing {items.length === 0 ? 0 : page * PAGE_SIZE + 1}–{page * PAGE_SIZE + items.length} of {total}</span>
        <span className="toolbar-spacer" />
        {selectMode && (
          <button className="btn-ghost" onClick={selectAllMatching} disabled={selectingAll || total === 0}>
            {selectingAll ? 'Selecting…' : `Select All${total ? ` (${total})` : ''}`}
          </button>
        )}
        <button className="btn-ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Prev</button>
        <span className="page-num">
          <span className="page-of">Page</span>
          <input className="page-input" type="text" inputMode="numeric" value={pageInput}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '');  // digits only — strips . - e + etc.
              if (v === '') { setPageInput(''); return; }
              setPageInput(String(Math.min(totalPages, Math.max(1, parseInt(v, 10)))));  // clamp to [1, max]
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); goToPage(); } }}
            onBlur={goToPage} aria-label="Go to page" />
          <span className="page-of">/ {totalPages}</span>
        </span>
        <button className="btn-ghost" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button>
        <button className="icon-btn" onClick={async () => { if (onReload) { setLoading(true); try { await onReload(); } catch { /* ignore */ } } refresh(page); refreshCounts(); }} disabled={loading} aria-label="Reload">
          <span className={`reload-icon ${loading ? 'reload-icon-spinning' : ''}`}><IconReload size={16} /></span>
        </button>
      </div>

      <InventoryTable items={items} loading={loading} role={user?.role} sort={sort} onSort={setSort} onUpdated={patchItem}
        selectMode={selectMode} selected={selected} onToggleSelect={toggleSelect} onToggleSelectAll={toggleSelectAll} allowStatusEdit={allowStatusEdit} showReasonCol={showReasonCol} />

      {showFilters && (
        <FilterPanel initial={filterFormState} defaultCity={city} role={user?.role}
          showReason={reasonFilter} showFollowUp={!hideFollowUpFilter}
          {...(reasonOptions ? { reasonOptions } : {})}
          onClose={() => setShowFilters(false)}
          onApply={(applied, form) => { setFiltersApplied(applied); setFilterFormState(form); setShowFilters(false); }} />
      )}
      {showAddModal && (
        <AddInventoryModal onClose={() => setShowAddModal(false)} onAdded={() => { setShowAddModal(false); refresh(0); refreshCounts(); }} />
      )}
    </div>
  );
}
