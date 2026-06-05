import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

function formatTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`;
}
function categoryClass(t) {
  return ({ auth: 'cat-pill cat-auth', inventory: 'cat-pill cat-inventory', user: 'cat-pill cat-user', sync: 'cat-pill cat-sync', cp_match_scan: 'cat-pill cat-sync', supply_sync: 'cat-pill cat-sync' })[t] || 'cat-pill cat-default';
}

function Details({ row }) {
  const { field, before_value, after_value, metadata, action, entity_type } = row;
  // CP Inventory match scan run — summarise the per-verdict counts.
  if (entity_type === 'cp_match_scan' && metadata && typeof metadata === 'object') {
    return (
      <div>
        <div className="det-change"><strong>CP match scan</strong> · {metadata.total ?? '?'} rows</div>
        <div className="det-sub">perfect {metadata.perfect ?? 0} · partial {metadata.partial ?? 0} · no match {metadata.no_match ?? 0}</div>
      </div>
    );
  }
  // Supply Closure Tracker sync run — summarise what was pulled and updated.
  if (entity_type === 'supply_sync' && metadata && typeof metadata === 'object') {
    return (
      <div>
        <div className="det-change"><strong>Supply sync</strong> · {metadata.updated ?? 0} updated</div>
        <div className="det-sub">{metadata.matched ?? 0} matched of {metadata.source_rows ?? 0} source rows</div>
      </div>
    );
  }
  if (field && (before_value != null || after_value != null) && action !== 'note_added') {
    return (
      <div><div className="det-change"><span className="det-before">{before_value ?? '—'}</span><span className="det-arrow"> → </span><span className="det-after">{after_value ?? '—'}</span></div><div className="det-sub">Field: <code>{field}</code></div></div>
    );
  }
  if (action === 'note_added') return <div><div className="det-change"><strong>Note added</strong>{metadata?.author_name && <span className="det-sub"> by {metadata.author_name}</span>}</div>{after_value && <div className="det-after det-note-body">{after_value}</div>}</div>;
  if (action === 'create') return <span className="det-after">Created</span>;
  if (action === 'login') return <span className="muted">Logged in</span>;
  if (metadata && typeof metadata === 'object') return <code className="det-meta">{JSON.stringify(metadata)}</code>;
  return <span className="muted">—</span>;
}

function SortableTh({ field, label, sort, onSort }) {
  const active = sort.field === field;
  const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
  return <th className={`al-th al-th-sortable ${active ? 'al-th-active' : ''}`} onClick={() => onSort({ field, dir: active ? (sort.dir === 'asc' ? 'desc' : 'asc') : 'desc' })}>{label} <span>{arrow}</span></th>;
}

export default function Logs() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [opts, setOpts] = useState({ actions: [], entity_types: [], actors: [] });
  const [f, setF] = useState({ q: '', action: '', entity_type: '', actor_email: '', from: '', to: '' });
  const [sort, setSort] = useState({ field: 'created_at', dir: 'desc' });
  const [loading, setLoading] = useState(true);

  async function loadFilters() { try { setOpts(await api.get('/api/activity/filters')); } catch { /* non-blocking */ } }
  async function refresh() {
    setLoading(true);
    const params = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => v && params.set(k, v));
    if (sort.field !== 'created_at' || sort.dir !== 'desc') { params.set('sort', sort.field); params.set('dir', sort.dir); }
    params.set('limit', '500');
    try { const r = await api.get(`/api/activity?${params}`); setItems(r.items); setTotal(r.total); } finally { setLoading(false); }
  }
  useEffect(() => { loadFilters(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [sort.field, sort.dir]);

  return (
    <div>
      <div className="al-head"><div><div className="al-subtitle">All dashboard activity</div></div><div className="al-result-count">{total} result{total === 1 ? '' : 's'}</div></div>

      <div className="al-filters">
        <input className="al-filter-input" placeholder="Search actor, action, UID, details…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && refresh()} />
        <select className="al-filter-select" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}><option value="">Action</option>{opts.actions.map((a) => <option key={a} value={a}>{a}</option>)}</select>
        <select className="al-filter-select" value={f.entity_type} onChange={(e) => setF({ ...f, entity_type: e.target.value })}><option value="">Category</option>{opts.entity_types.map((t) => <option key={t} value={t}>{t}</option>)}</select>
        <select className="al-filter-select" value={f.actor_email} onChange={(e) => setF({ ...f, actor_email: e.target.value })}><option value="">Actor</option>{opts.actors.map((a) => <option key={a.email} value={a.email}>{a.name || a.email}</option>)}</select>
        <div className="al-date-range"><span className="al-date-lbl">DATE</span><input type="date" className="al-date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><span className="al-date-sep">to</span><input type="date" className="al-date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
        <button className="btn-primary" onClick={refresh}>Apply</button>
      </div>

      {total >= 500 && <div className="al-banner">Showing first 500 results. Narrow filters for more specific results.</div>}

      <div className="al-table-wrap">
        <table className="al-table">
          <thead><tr>
            <SortableTh field="created_at" label="Timestamp" sort={sort} onSort={setSort} />
            <SortableTh field="entity_id" label="UID" sort={sort} onSort={setSort} />
            <SortableTh field="actor_email" label="Actor" sort={sort} onSort={setSort} />
            <SortableTh field="action" label="Action" sort={sort} onSort={setSort} />
            <SortableTh field="entity_type" label="Category" sort={sort} onSort={setSort} />
            <th className="al-th">Details</th>
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={6} className="al-empty">Loading…</td></tr>
              : items.length === 0 ? <tr><td colSpan={6} className="al-empty">No matching activity.</td></tr>
                : items.map((a) => (
                  <tr key={a.id}>
                    <td className="al-ts">{formatTs(a.created_at)}</td>
                    <td className="al-uid">{a.entity_id || '—'}</td>
                    <td><div className="al-actor-name">{a.actor_name || '—'}</div><div className="al-actor-email">{a.actor_email}</div></td>
                    <td className="al-action"><code>{a.action || '—'}</code></td>
                    <td><span className={categoryClass(a.entity_type)}>{a.entity_type || '—'}</span></td>
                    <td><Details row={a} /></td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
