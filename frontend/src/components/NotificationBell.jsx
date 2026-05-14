import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { displayCity, stageLabel } from '../utils/format.js';
import CardDetailModal from './CardDetailModal.jsx';

/**
 * Topbar bell — pulls `/api/inventory/notifications` and shows two buckets:
 *   1. Newly added inventories (last 24 hours)
 *   2. Today's follow-ups
 * Click a row to open its detail modal directly.
 *
 * Visibility scoping happens on the backend (admin sees all, manager sees
 * own cities, RM sees own rows).
 */
export default function NotificationBell({ role }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ new_items: [], today_follow_ups: [], total: 0 });
  const [openItem, setOpenItem] = useState(null);
  const ref = useRef(null);

  async function refresh() {
    try {
      const r = await api.get('/api/inventory/notifications');
      setData(r);
    } catch { /* non-blocking */ }
  }

  useEffect(() => { refresh(); }, []);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function openRow(oh_id) {
    api.get(`/api/inventory/${oh_id}`).then(setOpenItem).catch(() => {});
    setOpen(false);
  }

  const total = data.total || 0;

  return (
    <div className="bell-wrap" ref={ref}>
      <button
        type="button"
        className="bell-btn"
        onClick={() => { setOpen((p) => !p); if (!open) refresh(); }}
        aria-label={`Notifications: ${total}`}
        title={`Notifications: ${total}`}
      >
        <span className="bell-icon">🔔</span>
        {total > 0 && <span className="bell-badge">{total > 99 ? '99+' : total}</span>}
      </button>

      {open && (
        <div className="bell-dropdown">
          <div className="bell-section">
            <div className="bell-section-head">
              New Inventory ({data.new_items.length})
              <span className="bell-section-hint">last 24 hours</span>
            </div>
            {data.new_items.length === 0 ? (
              <div className="bell-empty">Nothing new.</div>
            ) : data.new_items.map((it) => (
              <button
                key={it.oh_id}
                type="button"
                className="bell-row"
                onClick={() => openRow(it.oh_id)}
              >
                <span className="bell-oh-id">{it.oh_id}</span>
                <span className="bell-soc">{it.society || '—'}</span>
                <span className="bell-meta">
                  {displayCity(it.city)}
                  {it.bedrooms != null ? ` · ${it.bedrooms} BHK` : ''}
                  {it.floor ? ` · ${it.floor}` : ''}
                  {it.source ? ` · ${it.source}` : ''}
                </span>
              </button>
            ))}
          </div>

          <div className="bell-section">
            <div className="bell-section-head">
              Today's Follow-ups ({data.today_follow_ups.length})
            </div>
            {data.today_follow_ups.length === 0 ? (
              <div className="bell-empty">Nothing scheduled.</div>
            ) : data.today_follow_ups.map((it) => (
              <button
                key={it.oh_id}
                type="button"
                className="bell-row"
                onClick={() => openRow(it.oh_id)}
              >
                <span className="bell-oh-id">{it.oh_id}</span>
                <span className="bell-soc">{it.society || '—'}</span>
                <span className="bell-meta">
                  {it.seller_name || '—'}
                  {it.seller_phone ? ` · ${it.seller_phone}` : ''}
                  {it.stage ? ` · ${stageLabel(it.stage)}` : ''}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {openItem && (
        <CardDetailModal
          item={openItem}
          role={role}
          onUpdated={(updated) => setOpenItem((p) => ({ ...p, ...updated }))}
          onClose={() => { setOpenItem(null); refresh(); }}
        />
      )}
    </div>
  );
}
