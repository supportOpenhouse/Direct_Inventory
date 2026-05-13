import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { CITIES, STAGES, STAGE_DOT_COLOR, formatDateRel, stageLabel } from '../utils/format.js';
import InventoryCard from '../components/InventoryCard.jsx';
import AddInventoryModal from '../components/AddInventoryModal.jsx';
import FilterPanel from '../components/FilterPanel.jsx';
import BulkActionBar from '../components/BulkActionBar.jsx';

const KANBAN_PER_COL = 50;     // top N per stage in the All/kanban view
const PAGE_SIZE = 100;         // page size when a stage filter is active

export default function Board() {
  const { user } = useAuth();
  // qInput vs qApplied — search applies only on submit (avoids per-keystroke races).
  const [qInput, setQInput] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [city, setCity] = useState('');
  const [stageFilter, setStageFilter] = useState(null);   // null = "All" (kanban)
  const [page, setPage] = useState(0);

  // Extended filters from the FilterPanel modal.
  // filtersApplied is the URL-ready dict; filterFormState is the raw form draft
  // so reopening the panel restores the user's choices (BHK pills, presets, etc.).
  const [filtersApplied, setFiltersApplied] = useState({});
  const [filterFormState, setFilterFormState] = useState({});
  const [showFilters, setShowFilters] = useState(false);

  // Bulk-select mode.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());

  // For kanban view: { stage_name: items[] }
  const [grouped, setGrouped] = useState({});
  // For filtered single-column view: items[] of the active stage
  const [items, setItems] = useState([]);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [counts, setCounts] = useState({ total: 0, by_stage: {} });
  const [lastSync, setLastSync] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  function makeFilterParams() {
    const p = new URLSearchParams();
    if (qApplied) p.set('q', qApplied);
    if (city) p.set('city', city);
    for (const [k, v] of Object.entries(filtersApplied)) {
      p.set(k, String(v));
    }
    return p;
  }

  async function refreshCounts() {
    try {
      const params = makeFilterParams();
      const r = await api.get(`/api/inventory/counts?${params}`);
      setCounts(r);
    } catch { /* non-blocking */ }
  }

  async function refreshKanban() {
    setLoading(true);
    try {
      const results = await Promise.all(STAGES.map(async (s) => {
        const params = makeFilterParams();
        params.set('stage', s);
        params.set('limit', String(KANBAN_PER_COL));
        const r = await api.get(`/api/inventory?${params}`);
        return [s, r.items];
      }));
      const next = {};
      for (const [s, list] of results) next[s] = list;
      setGrouped(next);
    } finally {
      setLoading(false);
    }
  }

  async function refreshFiltered(currentPage = page) {
    setLoading(true);
    try {
      const params = makeFilterParams();
      params.set('stage', stageFilter);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(currentPage * PAGE_SIZE));
      const r = await api.get(`/api/inventory?${params}`);
      setItems(r.items);
      setFilteredTotal(r.total);
    } finally {
      setLoading(false);
    }
  }

  async function refreshLastSync() {
    if (user?.role !== 'admin' && user?.role !== 'manager') return;
    try {
      const r = await api.get('/api/sync/last');
      if (r?.created_at) setLastSync(r);
    } catch { /* ignore */ }
  }

  // Re-load counts and the active board view when any applied filter changes.
  useEffect(() => { refreshCounts(); /* eslint-disable-next-line */ }, [city, qApplied, filtersApplied]);
  useEffect(() => {
    setPage(0);
    if (stageFilter) refreshFiltered(0); else refreshKanban();
    /* eslint-disable-next-line */
  }, [city, qApplied, stageFilter, filtersApplied]);
  useEffect(() => {
    if (stageFilter) refreshFiltered(page);
    /* eslint-disable-next-line */
  }, [page]);
  useEffect(() => { refreshLastSync(); /* eslint-disable-next-line */ }, []);

  function onSearch(e) {
    e?.preventDefault();
    setQApplied(qInput.trim());
  }

  function patchItemInState(updated) {
    setItems((prev) => prev.map((it) => (it.oh_id === updated.oh_id ? { ...it, ...updated } : it)));
    setGrouped((prev) => {
      const next = { ...prev };
      for (const s of STAGES) {
        next[s] = (next[s] || []).map((it) => (it.oh_id === updated.oh_id ? { ...it, ...updated } : it));
      }
      return next;
    });
  }

  function selectStage(s) {
    setStageFilter((current) => (current === s ? null : s));
  }

  function toggleSelect(oh_id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(oh_id)) next.delete(oh_id); else next.add(oh_id);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function exitSelectMode() {
    setSelectMode(false);
    clearSelection();
  }

  function onBulkDone(result) {
    // Refresh everything; the changes may move rows between columns.
    clearSelection();
    setSelectMode(false);
    refreshCounts();
    if (stageFilter) refreshFiltered(page); else refreshKanban();
    if (result?.skipped_forbidden?.length || result?.not_found?.length) {
      alert(
        `Updated ${result.updated} of ${result.requested}.\n` +
        (result.skipped_forbidden?.length ? `Forbidden: ${result.skipped_forbidden.length}\n` : '') +
        (result.not_found?.length ? `Not found: ${result.not_found.length}` : '')
      );
    }
  }

  const totalPages = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));
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
          className={!stageFilter ? 'count-pill count-pill-active' : 'count-pill'}
          onClick={() => setStageFilter(null)}
        >
          <div className="num">{counts.total}</div><div className="lbl">ALL</div>
        </button>
        {STAGES.map((s) => (
          <button
            key={s}
            type="button"
            className={stageFilter === s ? 'count-pill count-pill-active' : 'count-pill'}
            onClick={() => selectStage(s)}
          >
            <div className="num" style={{ color: STAGE_DOT_COLOR[s] }}>{counts.by_stage?.[s] ?? 0}</div>
            <div className="lbl">{stageLabel(s).toUpperCase()}</div>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading">Loading…</div>
      ) : stageFilter ? (
        <div className="filtered-list">
          <div className="filtered-header">
            <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[stageFilter] }} />
            <strong>{stageLabel(stageFilter)}</strong>
            <span className="muted">
              showing {items.length === 0 ? 0 : page * PAGE_SIZE + 1}
              –{page * PAGE_SIZE + items.length} of {filteredTotal}
            </span>
            <span className="toolbar-spacer" />
            <button className="btn-ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Prev</button>
            <span className="page-num">Page {page + 1} / {totalPages}</span>
            <button className="btn-ghost" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button>
          </div>
          <div className="filtered-grid">
            {items.map((it) => (
              <InventoryCard
                key={it.oh_id}
                item={it}
                role={user?.role}
                onUpdated={patchItemInState}
                selectMode={selectMode}
                selected={selected.has(it.oh_id)}
                onToggleSelect={() => toggleSelect(it.oh_id)}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="kanban">
          {STAGES.map((s) => {
            const list = grouped[s] || [];
            const totalForStage = counts.by_stage?.[s] ?? 0;
            const more = Math.max(0, totalForStage - list.length);
            return (
              <div key={s} className="kanban-col">
                <div className="col-head">
                  <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[s] }} />
                  <span className="col-title">{stageLabel(s)}</span>
                  <span className="col-count">{totalForStage}</span>
                </div>
                <div className="col-body">
                  {list.map((it) => (
                    <InventoryCard
                      key={it.oh_id}
                      item={it}
                      role={user?.role}
                      onUpdated={patchItemInState}
                      selectMode={selectMode}
                      selected={selected.has(it.oh_id)}
                      onToggleSelect={() => toggleSelect(it.oh_id)}
                    />
                  ))}
                  {more > 0 && (
                    <button className="view-all-link" onClick={() => setStageFilter(s)}>
                      View all {totalForStage} →
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <AddInventoryModal
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            refreshCounts();
            if (stageFilter) refreshFiltered(0); else refreshKanban();
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
