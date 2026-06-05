import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { displayCity, stageLabel } from '../utils/format.js';
import { IconBell } from './icons.jsx';
import CardDetailModal from './CardDetailModal.jsx';

/**
 * Topbar bell — two buckets: new inventory (last 24h) and today's follow-ups.
 * Backend scopes visibility by role. Clicking a row opens its detail modal.
 */
export default function NotificationBell({ role }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ new_items: [], today_follow_ups: [], total: 0 });
  const [openItem, setOpenItem] = useState(null);
  const ref = useRef(null);

  async function refresh() {
    try { setData(await api.get('/api/inventory/notifications')); } catch { /* non-blocking */ }
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function openRow(ohId) {
    api.get(`/api/inventory/${ohId}`).then(setOpenItem).catch(() => {});
    setOpen(false);
  }

  const total = data.total || 0;

  return (
    <div className="bell-wrap" ref={ref}>
      <button type="button" className="icon-btn bell-btn" onClick={() => { setOpen((p) => !p); if (!open) refresh(); }} aria-label={`Notifications: ${total}`}>
        <IconBell />
        {total > 0 && <span className="bell-badge">{total > 99 ? '99+' : total}</span>}
      </button>

      {open && (
        <div className="bell-dropdown">
          <div className="bell-section">
            <div className="bell-section-head">New Inventory ({data.new_items.length})<span className="bell-section-hint">last 24h</span></div>
            {data.new_items.length === 0 ? <div className="bell-empty">Nothing new.</div> : data.new_items.map((it) => (
              <button key={it.oh_id} type="button" className="bell-row" onClick={() => openRow(it.oh_id)}>
                <span className="bell-oh-id">{it.oh_id}</span>
                <span className="bell-soc">{it.society || '—'}</span>
                <span className="bell-meta">{displayCity(it.city)}{it.bedrooms != null ? ` · ${it.bedrooms} BHK` : ''}{it.source ? ` · ${it.source}` : ''}</span>
              </button>
            ))}
          </div>
          <div className="bell-section">
            <div className="bell-section-head">Today's Follow-ups ({data.today_follow_ups.length})</div>
            {data.today_follow_ups.length === 0 ? <div className="bell-empty">Nothing scheduled.</div> : data.today_follow_ups.map((it) => (
              <button key={it.oh_id} type="button" className="bell-row" onClick={() => openRow(it.oh_id)}>
                <span className="bell-oh-id">{it.oh_id}</span>
                <span className="bell-soc">{it.society || '—'}</span>
                <span className="bell-meta">{it.seller_name || '—'}{it.seller_phone ? ` · ${it.seller_phone}` : ''}{it.stage ? ` · ${stageLabel(it.stage)}` : ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {openItem && (
        <CardDetailModal item={openItem} role={role} onUpdated={(u) => setOpenItem((p) => ({ ...p, ...u }))} onClose={() => { setOpenItem(null); refresh(); }} />
      )}
    </div>
  );
}
