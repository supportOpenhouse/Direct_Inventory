import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

export default function AdminActivity() {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState({ entity_type: '', entity_id: '', actor_email: '' });

  async function refresh() {
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([k, v]) => v && params.set(k, v));
    params.set('limit', '500');
    const r = await api.get(`/api/activity?${params}`);
    setItems(r.items);
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="admin-page">
      <h2>Activity Log</h2>
      <div className="filters-row">
        <input placeholder="entity_type" value={filter.entity_type}
               onChange={(e) => setFilter({ ...filter, entity_type: e.target.value })} />
        <input placeholder="entity_id (e.g. OHLND0001)" value={filter.entity_id}
               onChange={(e) => setFilter({ ...filter, entity_id: e.target.value })} />
        <input placeholder="actor_email" value={filter.actor_email}
               onChange={(e) => setFilter({ ...filter, actor_email: e.target.value })} />
        <button className="btn-primary" onClick={refresh}>Filter</button>
      </div>
      <table className="data-table">
        <thead><tr><th>When</th><th>Actor</th><th>Entity</th><th>Action</th><th>Field</th><th>Before → After</th></tr></thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.created_at).toLocaleString()}</td>
              <td>{a.actor_email}</td>
              <td>{a.entity_type} <code>{a.entity_id || ''}</code></td>
              <td>{a.action}</td>
              <td>{a.field || '—'}</td>
              <td>{a.before_value || ''} → {a.after_value || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
