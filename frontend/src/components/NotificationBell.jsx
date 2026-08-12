import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { displayCity, stageLabel } from '../utils/format.js';
import { IconBell } from './icons.jsx';
import CardDetailModal from './CardDetailModal.jsx';

/**
 * Topbar bell. Opens to a list of CATEGORIES with counts; clicking a category
 * expands a drawer of its leads below it. Backend scopes visibility by role;
 * clicking a lead opens its detail modal.
 */
export default function NotificationBell({ role }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ new_items: [], today_follow_ups: [], total: 0 });
  const [openCat, setOpenCat] = useState(null);   // which category drawer is expanded
  const [openItem, setOpenItem] = useState(null);
  const ref = useRef(null);

  async function refresh() {
    try { setData(await api.get('/api/inventory/notifications')); } catch { /* non-blocking */ }
  }
  // Refresh on mount, every 60s while the tab is visible, and on focus/return —
  // so the badge count stays live without waiting for the user to open the bell.
  useEffect(() => {
    refresh();
    const id = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);
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

  // Category definitions — label, hint, its leads, and how to render each row's
  // meta line. `today_follow_ups` uses the seller/stage line; `new_items` the
  // city/BHK/source line.
  const categories = [
    {
      key: 'new_items', label: 'New Inventory', hint: 'last 24h', items: data.new_items,
      meta: (it) => `${displayCity(it.city)}${it.bedrooms != null ? ` · ${it.bedrooms} BHK` : ''}${it.source ? ` · ${it.source}` : ''}`,
    },
    {
      key: 'today_follow_ups', label: "Today's Follow-ups", items: data.today_follow_ups,
      meta: (it) => `${it.seller_name || '—'}${it.seller_phone ? ` · ${it.seller_phone}` : ''}${it.stage ? ` · ${stageLabel(it.stage)}` : ''}`,
    },
  ];

  return (
    <div className="bell-wrap" ref={ref}>
      <button type="button" className="icon-btn bell-btn" onClick={() => { setOpen((p) => !p); if (!open) { refresh(); setOpenCat(null); } }} aria-label={`Notifications: ${total}`}>
        <IconBell />
        {total > 0 && <span className="bell-badge">{total > 99 ? '99+' : total}</span>}
      </button>

      {open && (
        <div className="bell-dropdown">
          {categories.map((c) => (
            <div key={c.key} className="bell-cat">
              <button type="button" className="bell-cat-head" onClick={() => setOpenCat((p) => (p === c.key ? null : c.key))} aria-expanded={openCat === c.key}>
                <span className="bell-cat-name">{c.label}{c.hint && <span className="bell-section-hint">{c.hint}</span>}</span>
                <span className={`bell-cat-count ${c.items.length === 0 ? 'bell-cat-count-zero' : ''}`}>{c.items.length}</span>
                <span className={`bell-cat-chev ${openCat === c.key ? 'open' : ''}`} aria-hidden="true">▾</span>
              </button>
              {openCat === c.key && (
                <div className="bell-drawer">
                  {c.items.length === 0 ? <div className="bell-empty">Nothing here.</div> : c.items.map((it) => (
                    <button key={it.oh_id} type="button" className="bell-row" onClick={() => openRow(it.oh_id)}>
                      <span className="bell-oh-id">{it.oh_id}</span>
                      <span className="bell-soc">{it.society || '—'}</span>
                      <span className="bell-meta">{c.meta(it)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {openItem && (
        <CardDetailModal item={openItem} role={role} onUpdated={(u) => setOpenItem((p) => ({ ...p, ...u }))} onClose={() => { setOpenItem(null); refresh(); }} />
      )}
    </div>
  );
}
