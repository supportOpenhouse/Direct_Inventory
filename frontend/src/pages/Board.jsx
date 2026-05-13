import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { CITIES, STAGES, STAGE_DOT_COLOR, formatDateRel, stageLabel } from '../utils/format.js';
import InventoryTable from '../components/InventoryTable.jsx';
import CardDetailModal from '../components/CardDetailModal.jsx';
import AddInventoryModal from '../components/AddInventoryModal.jsx';
import FilterPanel from '../components/FilterPanel.jsx';
import BulkActionBar from '../components/BulkActionBar.jsx';

const PAGE_SIZE = 100;

export default function Board() {
  const { user } = useAuth();
  // Search — committed-only to avoid per-keystroke races.
  const [qInput, setQInput] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [city, setCity] = useState('');
  // Multi-select stage filter. Empty set = "All".
  const [stageSel, setStageSel] = useState(() => new Set());
  const [sort, setSort] = useState({ field: 'updated_at', dir: 'desc' });
  const [page, setPage] = useState(0);

  // Extended filters from the FilterPanel modal.
  const [filtersApplied, setFiltersApplied] = useState({});
  const [filterFormState, setFilterFormState] = useState({});
  const [showFilters, setShowFilters] = useState(false);

  // Bulk-select mode.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());

  // Detail modal for the clicked row.
  const [openItem, setOpenItem] = useState(null);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [counts, setCounts] = useState({ total: 0, by_stage: {} });
  const [lastSync, setLastSync] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  function makeParams() {
    const p = new URLSearchParams();
    if (qApplied) p.set('q', qApplied);
    if (city) p.set('city', city);
    if (stageSel.size > 0) p.set('stage', Array.from(stageSel).join(','));
    if (sort.field && sort.field !== 'updated_at') {
      p.set('sort', sort.field);
      p.set('dir', sort.dir);
    } else if (sort.dir !== 'desc') {
      p.set('sort', sort.field);
      p.set('dir', sort.dir);
    }
    for (const [k, v] of Object.entries(filtersApplied)) p.set(k, String(v));
    return p;
  }

  async function refresh(currentPage = page) {
    setLoading(true);
    try {
      const params = makeParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(currentPage * PAGE_SIZE));
      const r = await api.get(`/api/inventory?${params}`);
      setItems(r.items);
      setTotal(r.total);
    } finally {
      setLoading(false);
    }
  }

  async function refreshCounts() {
    try {
      const params = makeParams();
      const r = await api.get(`/api/inventory/counts?${params}`);
      setCounts(r);
    } catch { /* non-blocking */ }
  }

  async function refreshLastSync() {
    if (user?.role !== 'admin' && user?.role !== 'manager') return;
    try {
      const r = await api.get('/api/sync/last');
      if (r?.created_at) setLastSync(r);
    } catch { /* ignore */ }
  }

  // Reset to page 0 + reload whenever filters / sort / search change.
  useEffect(() => {
    setPage(0);
    refresh(0);
    refreshCounts();
    /* eslint-disable-next-line */
  }, [city, qApplied, stageSel, filtersApplied, sort.field, sort.dir]);
  useEffect(() => { refresh(page); /* eslint-disable-next-line */ }, [page]);
  useEffect(() => { refreshLastSync(); /* eslint-disable-next-line */ }, []);

  function onSearch(e) {
    e?.preventDefault();
    setQApplied(qInput.trim());
  }

  function toggleStage(s) {
    setStageSel((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }
  function clearStages() { setStageSel(new Set()); }

  function patchItemInState(updated) {
    setItems((prev) => prev.map((it) => (it.oh_id === updated.oh_id ? { ...it, ...updated } : it)));
    if (openItem && openItem.oh_id === updated.oh_id) {
      setOpenItem((p) => ({ ...p, ...updated }));
    }
  }

  function toggleSelect(oh_id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(oh_id)) next.delete(oh_id); else next.add(oh_id);
      return next;
    });
  }
  function clearSelection() { setSelected(new Set()); }
  function exitSelectMode() { setSelectMode(false); clearSelection(); }

  function onBulkDone(result) {
    clearSelection();
    setSelectMode(false);
    refreshCounts();
    refresh(page);
    if (result?.skipped_forbidden?.length || result?.not_found?.length) {
      alert(
        `Updated ${result.updated} of ${result.requested}.\n` +
        (result.skipped_forbidden?.length ? `Forbidden: ${result.skipped_forbidden.length}\n` : '') +
        (result.not_found?.length ? `Not found: ${result.not_found.length}` : '')
      );
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filterCount = Object.keys(filtersApplied).length;

  return (
    <div className="board-page">
      <div className="board-toolbar">
        <div className="city-tabs">
          <button className={!city ? 'tab tab-active' : 'tab'} onClick={() => setCity('')}>All</button>
          {CITIES.map((c) => (
            <button key={c} className={city === c ? 'tab tab-active' : 'tab'} onClick={() => setCity(c)}>{c}</button>
          ))}
        </div>
        <form className="search-form" onSubmit={onSearch}>
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Search society, OH-ID, seller, locality, source… (press Enter)"
          />
          <button type="submit" className="btn-primary">Search</button>
          {qApplied && (
            <button type="button" className="btn-ghost" onClick={() => { setQInput(''); setQApplied(''); }}>
              Clear
            </button>
          )}
        </form>
        <button className="btn-ghost" onClick={() => setShowFilters(true)}>
          Filters{filterCount ? ` (${filterCount})` : ''}
        </button>
        {filterCount > 0 && (
          <button className="btn-link" onClick={() => { setFiltersApplied({}); setFilterFormState({}); }}>
            Reset
          </button>
        )}
        <div className="toolbar-spacer" />
        {lastSync && (
          <span
            className="last-sync"
            title={`Last sync: ${new Date(lastSync.created_at).toLocaleString()} — fetched ${lastSync.metadata?.fetched ?? '?'}, inserted ${lastSync.metadata?.inserted ?? '?'}, updated ${lastSync.metadata?.updated ?? '?'}`}
          >
            Sync: {formatDateRel(lastSync.created_at)}
          </span>
        )}
        <button
          className={selectMode ? 'btn-primary' : 'btn-ghost'}
          onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
        >
          {selectMode ? 'Exit Select' : 'Select'}
        </button>
        <button className="btn-primary" onClick={() => setShowAdd(true)}>+ Add Inventory</button>
      </div>

      {selectMode && selected.size > 0 && (
        <BulkActionBar
          selected={selected}
          role={user?.role}
          onCleared={exitSelectMode}
          onDone={onBulkDone}
        />
      )}

      <div className="stage-counts">
        <button
          type="button"
          className={stageSel.size === 0 ? 'count-pill count-pill-active' : 'count-pill'}
          onClick={clearStages}
        >
          <div className="num">{counts.total}</div><div className="lbl">ALL</div>
        </button>
        {STAGES.map((s) => (
          <button
            key={s}
            type="button"
            className={stageSel.has(s) ? 'count-pill count-pill-active' : 'count-pill'}
            onClick={() => toggleStage(s)}
          >
            <div className="num" style={{ color: STAGE_DOT_COLOR[s] }}>{counts.by_stage?.[s] ?? 0}</div>
            <div className="lbl">{stageLabel(s).toUpperCase()}</div>
          </button>
        ))}
      </div>

      <div className="filtered-header">
        <span className="muted">
          showing {items.length === 0 ? 0 : page * PAGE_SIZE + 1}
          –{page * PAGE_SIZE + items.length} of {total}
        </span>
        <span className="toolbar-spacer" />
        <button className="btn-ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Prev</button>
        <span className="page-num">Page {page + 1} / {totalPages}</span>
        <button className="btn-ghost" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button>
      </div>

      {loading ? (
        <div className="loading">Loading…</div>
      ) : (
        <InventoryTable
          items={items}
          role={user?.role}
          sort={sort}
          onSort={setSort}
          onRowClick={(it) => setOpenItem(it)}
          onUpdated={patchItemInState}
          selectMode={selectMode}
          selected={selected}
          onToggleSelect={toggleSelect}
        />
      )}

      {openItem && (
        <CardDetailModal
          item={openItem}
          role={user?.role}
          onUpdated={patchItemInState}
          onClose={() => setOpenItem(null)}
        />
      )}

      {showAdd && (
        <AddInventoryModal
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            refreshCounts();
            refresh(0);
          }}
        />
      )}

      {showFilters && (
        <FilterPanel
          initial={filterFormState}
          defaultCity={city}
          onClose={() => setShowFilters(false)}
          onApply={(applied, formState) => {
            setFiltersApplied(applied);
            setFilterFormState(formState);
            setShowFilters(false);
          }}
        />
      )}
    </div>
  );
}
