import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { CITIES, STAGES, STAGE_DOT_COLOR, formatDateRel, stageLabel } from '../utils/format.js';
import InventoryCard from '../components/InventoryCard.jsx';
import AddInventoryModal from '../components/AddInventoryModal.jsx';

const KANBAN_PER_COL = 50;     // top N per stage in the All/kanban view
const PAGE_SIZE = 100;         // page size when a stage filter is active

export default function Board() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [city, setCity] = useState('');
  const [stageFilter, setStageFilter] = useState(null);   // null = "All" (kanban)
  const [page, setPage] = useState(0);

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
    if (q) p.set('q', q);
    if (city) p.set('city', city);
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
      // One call per stage in parallel — keeps each request small even with 15k+ rows.
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

  // Re-load counts whenever city/q changes; reload board view on stage/city/q/page change.
  useEffect(() => { refreshCounts(); /* eslint-disable-next-line */ }, [city, q]);
  useEffect(() => {
    setPage(0);
    if (stageFilter) refreshFiltered(0); else refreshKanban();
    /* eslint-disable-next-line */
  }, [city, q, stageFilter]);
  useEffect(() => {
    if (stageFilter) refreshFiltered(page);
    /* eslint-disable-next-line */
  }, [page]);
  useEffect(() => { refreshLastSync(); /* eslint-disable-next-line */ }, []);

  function onSearch(e) {
    e?.preventDefault();
    refreshCounts();
    if (stageFilter) refreshFiltered(0); else refreshKanban();
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
    // If the stage changed, the chip counts and column membership are now stale —
    // re-fetch counts and the active board view in the background.
    if (updated.stage) {
      refreshCounts();
      if (stageFilter) refreshFiltered(page); else refreshKanban();
    }
  }

  function selectStage(s) {
    setStageFilter((current) => (current === s ? null : s));
  }

  const totalPages = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));

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
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search society, OH-ID, seller, locality, source…"
          />
          <button type="submit" className="btn-primary">Search</button>
        </form>
        <div className="toolbar-spacer" />
        {lastSync && (
          <span
            className="last-sync"
            title={`Last sync: ${new Date(lastSync.created_at).toLocaleString()} — fetched ${lastSync.metadata?.fetched ?? '?'}, inserted ${lastSync.metadata?.inserted ?? '?'}, updated ${lastSync.metadata?.updated ?? '?'}`}
          >
            Sync: {formatDateRel(lastSync.created_at)}
          </span>
        )}
        <button className="btn-primary" onClick={() => setShowAdd(true)}>+ Add Inventory</button>
      </div>

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
              <InventoryCard key={it.oh_id} item={it} role={user?.role} onUpdated={patchItemInState} />
            ))}
          </div>
        </div>
      ) : (
        <div className="kanban">
          {STAGES.map((s) => {
            const list = grouped[s] || [];
            const totalForStage = counts.by_stage?.[s] ?? list.length;
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
                    <InventoryCard key={it.oh_id} item={it} role={user?.role} onUpdated={patchItemInState} />
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
          onAdded={(item) => {
            setShowAdd(false);
            refreshCounts();
            if (stageFilter) refreshFiltered(0); else refreshKanban();
          }}
        />
      )}
    </div>
  );
}
