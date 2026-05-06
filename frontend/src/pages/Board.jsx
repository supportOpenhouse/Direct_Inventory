import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { CITIES, STAGES, STAGE_DOT_COLOR, formatDateRel, stageLabel } from '../utils/format.js';
import InventoryCard from '../components/InventoryCard.jsx';
import AddInventoryModal from '../components/AddInventoryModal.jsx';

export default function Board() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [city, setCity] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [lastSync, setLastSync] = useState(null);

  async function refresh() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (city) params.set('city', city);
      params.set('limit', '500');
      const r = await api.get(`/api/inventory?${params}`);
      setItems(r.items);
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

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [city]);
  useEffect(() => { refreshLastSync(); /* eslint-disable-next-line */ }, []);

  function onSearch(e) {
    e?.preventDefault();
    refresh();
  }

  function patchItem(updated) {
    setItems((prev) => prev.map((it) => (it.oh_id === updated.oh_id ? { ...it, ...updated } : it)));
  }

  const grouped = useMemo(() => {
    const g = Object.fromEntries(STAGES.map((s) => [s, []]));
    for (const it of items) (g[it.stage] || (g[it.stage] = [])).push(it);
    return g;
  }, [items]);

  const counts = useMemo(() => {
    const c = { all: items.length };
    for (const s of STAGES) c[s] = grouped[s]?.length || 0;
    return c;
  }, [grouped, items]);

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
        <div className="count-pill"><div className="num">{counts.all}</div><div className="lbl">ALL</div></div>
        {STAGES.map((s) => (
          <div key={s} className="count-pill">
            <div className="num" style={{ color: STAGE_DOT_COLOR[s] }}>{counts[s]}</div>
            <div className="lbl">{stageLabel(s).toUpperCase()}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="loading">Loading…</div>
      ) : (
        <div className="kanban">
          {STAGES.map((s) => (
            <div key={s} className="kanban-col">
              <div className="col-head">
                <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[s] }} />
                <span className="col-title">{stageLabel(s)}</span>
                <span className="col-count">{grouped[s]?.length || 0}</span>
              </div>
              <div className="col-body">
                {(grouped[s] || []).map((it) => (
                  <InventoryCard key={it.oh_id} item={it} role={user?.role} onUpdated={patchItem} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <AddInventoryModal
          onClose={() => setShowAdd(false)}
          onAdded={(item) => { setShowAdd(false); setItems((p) => [item, ...p]); }}
        />
      )}
    </div>
  );
}
