import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import TicketModal, { ticketStatusClass, ticketStatusLabel } from '../components/TicketModal.jsx';
import { IconTicket } from '../components/icons.jsx';

const TABS = [
  { key: 'action', label: 'Needs my action' },
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
];

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

// Tickets workspace: filter by what needs my action / open / closed, click a
// ticket to read the thread, reply, and (creator/admin) close it. New tickets
// are raised from a property's expand panel, not here.
export default function Tickets() {
  const { user } = useAuth();
  const [tab, setTab] = useState('action');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (tab === 'action') p.set('scope', 'action');
      else p.set('status', tab);
      const r = await api.get(`/api/tickets?${p}`);
      setItems(r.items || []);
    } finally { setLoading(false); }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  // Refetch when a ticket is created/replied/closed anywhere (e.g. the topbar
  // New Ticket button).
  useEffect(() => {
    const onChanged = () => load();
    window.addEventListener('tickets:changed', onChanged);
    return () => window.removeEventListener('tickets:changed', onChanged);
  }, [load]);

  function onChanged(updated) {
    setItems((prev) => prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)));
  }

  return (
    <div>
      <div className="toolbar">
        <div className="city-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? 'tab tab-active' : 'tab'} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
        <div className="toolbar-spacer" />
        <span className="muted" style={{ fontSize: 13 }}>{items.length} ticket{items.length === 1 ? '' : 's'}</span>
      </div>

      {loading ? (
        <div className="tk-list">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="tk-card tk-card-skel" />)}</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <IconTicket size={28} />
          <p>{tab === 'action' ? 'Nothing needs your action right now.' : `No ${tab} tickets.`}</p>
        </div>
      ) : (
        <div className="tk-list">
          {items.map((t) => (
            <button key={t.id} type="button" className="tk-card" onClick={() => setOpen(t)}>
              <div className="tk-card-top">
                <span className="tk-card-title">{t.title}</span>
                <span className={`tk-badge ${ticketStatusClass(t)}`}>{ticketStatusLabel(t)}</span>
              </div>
              <div className="tk-card-prop">{t.oh_id ? `${t.society || '—'} · ${t.oh_id}` : 'Direct ticket'}{t.assigned_rm_name ? ` · RM: ${t.assigned_rm_name}` : ''}</div>
              {t.summary && <div className="tk-card-summary">{t.summary}</div>}
              <div className="tk-card-foot">
                <span>{(t.messages || []).length} repl{(t.messages || []).length === 1 ? 'y' : 'ies'}</span>
                <span>{fmtTime(t.last_activity_at)}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {open && <TicketModal ticket={open} onChanged={onChanged} onClose={() => { setOpen(null); load(); }} />}
    </div>
  );
}
