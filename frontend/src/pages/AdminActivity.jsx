import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { stageLabel } from '../utils/format.js';

// Pretty-print a timestamp like "14 May 2026, 12:32:51".
function formatTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return `${date}, ${time}`;
}

// Map raw entity_type → category pill colour class.
function categoryClass(t) {
  return ({
    auth:      'cat-pill cat-auth',
    inventory: 'cat-pill cat-inventory',
    user:      'cat-pill cat-user',
    sync:      'cat-pill cat-sync',
  })[t] || 'cat-pill cat-default';
}

// Build the right-hand "Details" cell from the row's columns.
function Details({ row }) {
  const { field, before_value, after_value, metadata, action, entity_type } = row;
  const md = metadata || null;

  // Field change with before/after — show strikethrough before → green after.
  // (note_added uses field='note' but has its own block below.)
  if (field && (before_value != null || after_value != null) && action !== 'note_added') {
    return (
      <div className="det-line">
        <div className="det-change">
          <span className="det-before">{before_value ?? '—'}</span>
          <span className="det-arrow"> → </span>
          <span className="det-after">{after_value ?? '—'}</span>
        </div>
        <div className="det-sub">Field: <code>{field}</code></div>
      </div>
    );
  }

  // Sync row: surface fetched/inserted/updated counts.
  if (entity_type === 'sync' && md) {
    return (
      <div className="det-line">
        <strong>Sync run</strong>
        <div className="det-sub">
          fetched {md.fetched ?? '?'} · inserted {md.inserted ?? '?'} · updated {md.updated ?? '?'}
          {md.errors ? ` · errors ${md.errors}` : ''}
        </div>
      </div>
    );
  }

  if (action === 'create' && entity_type === 'inventory') {
    const where = [md?.society, md?.city].filter(Boolean).join(', ');
    return (
      <div className="det-line">
        <div className="det-change">
          <strong>Created</strong>{where ? ` — ${where}` : ''}
        </div>
        {(md?.rm_user_id || md?.manager_user_id) && (
          <div className="det-sub">
            Auto-assigned
            {md.rm_user_id     ? ` · RM #${md.rm_user_id}`      : ''}
            {md.manager_user_id ? ` · Mgr #${md.manager_user_id}` : ''}
          </div>
        )}
        {md?.locality && <div className="det-sub muted">Locality: {md.locality}</div>}
      </div>
    );
  }
  // Bulk POC backfill — POST /api/inventory/assign-missing.
  if (action === 'assign_missing' && md && typeof md === 'object') {
    return (
      <div className="det-line">
        <div className="det-change">
          <strong>POC backfill</strong>
          <span> · {md.updated ?? '?'} assigned</span>
        </div>
        <div className="det-sub">
          scanned {md.scanned ?? '?'} · remaining {md.remaining ?? '?'}
        </div>
      </div>
    );
  }
  // New user auto-provisioned on first Google login.
  if (action === 'auto_provision' && md && typeof md === 'object') {
    return (
      <div className="det-line">
        <div className="det-change">
          <strong>Auto-provisioned</strong>{md.name ? ` — ${md.name}` : ''}
        </div>
      </div>
    );
  }
  // CP match scan run — POST /api/inventory/cp-match-scan completion summary.
  if (action === 'run' && md && typeof md === 'object'
      && ('perfect' in md || 'partial' in md || 'no_match' in md)) {
    return (
      <div className="det-line">
        <div className="det-change">
          <strong>CP match scan</strong>
          <span> · {md.total ?? '?'} rows</span>
        </div>
        <div className="det-sub">
          perfect {md.perfect ?? 0} · partial {md.partial ?? 0} · no match {md.no_match ?? 0}
        </div>
      </div>
    );
  }
  // Bulk CSV-driven stage move (one-shot cleanup script).
  if (action === 'bulk_stage_cleanup' && md && typeof md === 'object') {
    const from = md.from_stage ? stageLabel(md.from_stage) : '?';
    const to   = md.to_stage   ? stageLabel(md.to_stage)   : '?';
    return (
      <div className="det-line">
        <div className="det-change">
          <strong>Bulk stage cleanup</strong>
          <span> · {from} <span className="det-arrow">→</span> {to}</span>
        </div>
        <div className="det-sub">
          {md.updated ?? '?'} updated{md.csv ? ` · source: ${md.csv}` : ''}
        </div>
      </div>
    );
  }
  // Visit scheduled — POST /api/visits/schedule logs this with the field-exec
  // and slot details. Render it as a small structured block instead of raw JSON.
  if (action === 'visit_scheduled' && md && typeof md === 'object') {
    const when = (() => {
      if (!md.schedule_date) return null;
      const d = new Date(`${md.schedule_date}T${md.schedule_time || '00:00'}`);
      if (Number.isNaN(d.getTime())) {
        return `${md.schedule_date}${md.schedule_time ? ' ' + md.schedule_time : ''}`;
      }
      const dateStr = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      return md.schedule_time ? `${dateStr}, ${md.schedule_time}` : dateStr;
    })();
    return (
      <div className="det-line">
        <div className="det-change">
          <strong>Visit scheduled</strong>
          {md.field_exec_name && (
            <span> with {md.field_exec_name}{md.field_exec_phone ? ` (${md.field_exec_phone})` : ''}</span>
          )}
        </div>
        {when && <div className="det-sub">When: {when}</div>}
        {md.assigned_by_name && (
          <div className="det-sub">Assigned by: {md.assigned_by_name}</div>
        )}
        {md.forms_visit_id && (
          <div className="det-sub muted">Forms visit id: <code>{md.forms_visit_id}</code></div>
        )}
      </div>
    );
  }
  // Note added — show the comment text plain.
  if (action === 'note_added' && md && typeof md === 'object') {
    return (
      <div className="det-line">
        <div className="det-change">
          <strong>Note added</strong>
          {md.author_name && <span className="det-sub"> by {md.author_name}</span>}
        </div>
        {after_value && <div className="det-after det-note-body">{after_value}</div>}
      </div>
    );
  }
  if (action === 'login') {
    return <span className="muted">Logged in</span>;
  }
  if (action === 'upsert') {
    return <span className="muted">User upsert</span>;
  }
  if (md && typeof md === 'object') {
    // Generic fallback — JSON dump metadata if we don't recognise the shape.
    return <code className="det-meta">{JSON.stringify(md)}</code>;
  }
  return <span className="muted">—</span>;
}

function SortableTh({ field, label, sort, onSort }) {
  const active = sort.field === field;
  const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
  return (
    <th className={`al-th al-th-sortable ${active ? 'al-th-active' : ''}`}
        onClick={() => onSort({
          field,
          dir: active ? (sort.dir === 'asc' ? 'desc' : 'asc') : 'desc',
        })}>
      {label}
      <span className={active ? 'al-arrow-active' : 'al-arrow'}>{' '}{arrow}</span>
    </th>
  );
}

export default function AdminActivity() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [filterOpts, setFilterOpts] = useState({ actions: [], entity_types: [], actors: [] });
  const [f, setF] = useState({ q: '', action: '', entity_type: '', actor_email: '', from: '', to: '' });
  const [sort, setSort] = useState({ field: 'created_at', dir: 'desc' });
  const [loading, setLoading] = useState(true);

  async function loadFilters() {
    try {
      const r = await api.get('/api/activity/filters');
      setFilterOpts(r);
    } catch { /* non-blocking */ }
  }

  async function refresh() {
    setLoading(true);
    const params = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => v && params.set(k, v));
    if (sort.field !== 'created_at' || sort.dir !== 'desc') {
      params.set('sort', sort.field);
      params.set('dir', sort.dir);
    }
    params.set('limit', '500');
    try {
      const r = await api.get(`/api/activity?${params}`);
      setItems(r.items);
      setTotal(r.total);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadFilters(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [sort.field, sort.dir]);

  function applyAndRefresh() { refresh(); }

  return (
    <div className="admin-page activity-log-page">
      <div className="al-head">
        <div>
          <h2 className="al-title">Activity Logs</h2>
          <div className="al-subtitle">All Dashboard Logs</div>
        </div>
        <div className="al-result-count">{total} result{total === 1 ? '' : 's'}</div>
      </div>

      <div className="al-filters">
        <input
          className="al-filter-input"
          placeholder="Search by UID…"
          value={f.q}
          onChange={(e) => setF({ ...f, q: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && applyAndRefresh()}
        />

        <select className="al-filter-select" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>
          <option value="">Action</option>
          {filterOpts.actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>

        <select className="al-filter-select" value={f.entity_type} onChange={(e) => setF({ ...f, entity_type: e.target.value })}>
          <option value="">Category</option>
          {filterOpts.entity_types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        <select className="al-filter-select" value={f.actor_email} onChange={(e) => setF({ ...f, actor_email: e.target.value })}>
          <option value="">Actor Email</option>
          {filterOpts.actors.map((a) => (
            <option key={a.email} value={a.email}>
              {a.email === 'apps-script:*' ? 'Apps Script Sync (all batches)' : a.email}
            </option>
          ))}
        </select>

        <select className="al-filter-select" value={f.actor_email} onChange={(e) => setF({ ...f, actor_email: e.target.value })}>
          <option value="">Actor Name</option>
          {filterOpts.actors.filter((a) => a.name).map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
        </select>

        <div className="al-date-range">
          <span className="al-date-lbl">DATE:</span>
          <input type="date" className="al-date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <span className="al-date-sep">to</span>
          <input type="date" className="al-date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </div>

        <button className="btn-primary" onClick={applyAndRefresh}>Apply</button>
      </div>

      {total >= 500 && (
        <div className="al-banner">Showing first 500 results. Narrow filters for more specific results.</div>
      )}

      <div className="al-table-wrap">
        <table className="al-table">
          <thead>
            <tr>
              <SortableTh field="created_at" label="Timestamp" sort={sort} onSort={setSort} />
              <SortableTh field="entity_id"  label="UID"       sort={sort} onSort={setSort} />
              <SortableTh field="actor_email" label="Actor"    sort={sort} onSort={setSort} />
              <SortableTh field="action"     label="Action"    sort={sort} onSort={setSort} />
              <SortableTh field="entity_type" label="Category" sort={sort} onSort={setSort} />
              <th className="al-th">Details</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="al-empty">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={6} className="al-empty">No matching activity.</td></tr>
            ) : items.map((a) => (
              <tr key={a.id}>
                <td className="al-ts">{formatTs(a.created_at)}</td>
                <td className="al-uid">{a.entity_id || '—'}</td>
                <td className="al-actor">
                  <div className="al-actor-name">{a.actor_name || '—'}</div>
                  <div className="al-actor-email">{a.actor_email}</div>
                </td>
                <td className="al-action"><code>{a.action || '—'}</code></td>
                <td><span className={categoryClass(a.entity_type)}>{a.entity_type || '—'}</span></td>
                <td className="al-details"><Details row={a} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
