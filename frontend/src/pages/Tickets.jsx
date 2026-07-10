import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import TicketModal, { ticketStatusClass, ticketStatusLabel } from '../components/TicketModal.jsx';
import CardDetailModal from '../components/CardDetailModal.jsx';
import { IconTicket, IconSearch } from '../components/icons.jsx';

const TABS = [
  { key: 'action', label: 'Needs my action' },
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
];

const PAGE_SIZE = 50;

// Deterministic URL per tab/page so prefetches and tab clicks hit the same
// client-cache key.
function tabQuery(key, offset = 0, q = '') {
  const p = new URLSearchParams();
  if (key === 'action') p.set('scope', 'action');
  else p.set('status', key);
  if (q) p.set('q', q);
  p.set('limit', String(PAGE_SIZE));
  if (offset) p.set('offset', String(offset));
  return `/api/tickets?${p}`;
}

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
  const [qInput, setQInput] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState(null);
  const [openItem, setOpenItem] = useState(null);

  // Open the property detail modal for a ticket's oh_id. Open INSTANTLY with
  // what the ticket row already knows (society/city), then load the full record
  // so the modal fills in like a skeleton screen instead of lagging on the fetch.
  async function openProperty(ohId, seed) {
    if (!ohId) return;
    setOpenItem({ oh_id: ohId, ...seed, _loading: true });
    try {
      const item = await api.get(`/api/inventory/${ohId}`);
      setOpenItem((prev) => (prev && prev.oh_id === ohId ? { ...item, _loading: false } : prev));
    } catch {
      setOpenItem((prev) => (prev && prev.oh_id === ohId ? { ...prev, _loading: false } : prev));
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get(tabQuery(tab, 0, qApplied));
      setItems(r.items || []);
      setTotal(r.total || 0);
    } finally { setLoading(false); }
    // Warm the other tabs AFTER the active one renders (sequentially, so the
    // visible list always wins the bandwidth) — switching tabs then serves
    // from the client cache instead of refetching on click.
    TABS.filter((t) => t.key !== tab).reduce(
      (chain, t) => chain.then(() => api.get(tabQuery(t.key, 0, qApplied))).catch(() => {}),
      Promise.resolve()
    );
  }, [tab, qApplied]);

  function onSearch(e) { e.preventDefault(); setQApplied(qInput.trim()); }

  // "Load more" → append the next page (the list endpoint pages at 50).
  async function loadMore() {
    setLoadingMore(true);
    try {
      const r = await api.get(tabQuery(tab, items.length, qApplied));
      // Dedupe by id — replies/closes shift server offsets between pages.
      setItems((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...(r.items || []).filter((t) => !seen.has(t.id))];
      });
      setTotal(r.total || 0);
    } finally { setLoadingMore(false); }
  }

  useEffect(() => { load(); }, [load]);

  // Refetch when a ticket is created/replied/closed anywhere: locally
  // ('tickets:changed', e.g. the topbar New Ticket button) or by another user
  // ('tickets:updated', broadcast by Layout's pending-count poll).
  useEffect(() => {
    const onChanged = () => load();
    window.addEventListener('tickets:changed', onChanged);
    window.addEventListener('tickets:updated', onChanged);
    return () => {
      window.removeEventListener('tickets:changed', onChanged);
      window.removeEventListener('tickets:updated', onChanged);
    };
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
        <form className="search-form" onSubmit={onSearch}>
          <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search tickets — OH-ID, title, summary" />
          <button type="submit" className="btn-primary"><IconSearch size={16} /> Search</button>
          {qApplied && <button type="button" className="btn-ghost" onClick={() => { setQInput(''); setQApplied(''); }}>Clear</button>}
        </form>
        <span className="muted" style={{ fontSize: 13 }}>{total} ticket{total === 1 ? '' : 's'}</span>
      </div>

      {loading ? (
        <div className="tk-list">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="tk-card tk-card-skel" />)}</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <IconTicket size={28} />
          <p>{tab === 'action' ? 'Nothing needs your action right now.' : `No ${tab} tickets.`}</p>
        </div>
      ) : (
        <>
        <div className="tk-list">
          {items.map((t) => (
            <div
              key={t.id}
              className="tk-card"
              role="button"
              tabIndex={0}
              onClick={() => setOpen(t)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(t); }
              }}
            >
              <div className="tk-card-top">
                <span className="tk-card-title">{t.title}</span>
                <span className={`tk-badge ${ticketStatusClass(t)}`}>{ticketStatusLabel(t)}</span>
              </div>
              {t.oh_id ? (
                <button
                  type="button"
                  className="tk-card-prop tk-card-prop-link"
                  onClick={(e) => { e.stopPropagation(); openProperty(t.oh_id, { society: t.society, city: t.city }); }}
                  title={`Open ${t.oh_id} details`}
                >
                  {`${t.society || '—'} · ${t.oh_id}`}{t.assigned_rm_name ? ` · RM: ${t.assigned_rm_name}` : ''}
                </button>
              ) : (
                <div className="tk-card-prop">Direct ticket{t.assigned_rm_name ? ` · RM: ${t.assigned_rm_name}` : ''}</div>
              )}
              {t.summary && <div className="tk-card-summary">{t.summary}</div>}
              <div className="tk-card-foot">
                <span>{t.message_count ?? 0} repl{(t.message_count ?? 0) === 1 ? 'y' : 'ies'}</span>
                <span>{fmtTime(t.last_activity_at)}</span>
              </div>
            </div>
          ))}
        </div>
        {items.length < total && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
            <button type="button" className="btn-ghost" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : `Load more (${items.length} of ${total})`}
            </button>
          </div>
        )}
        </>
      )}

      {open && <TicketModal ticket={open} onChanged={onChanged} onClose={() => { setOpen(null); load(); }} />}
      {openItem && (
        <CardDetailModal
          item={openItem}
          role={user?.role}
          onUpdated={(u) => setOpenItem((p) => ({ ...p, ...u }))}
          onClose={() => setOpenItem(null)}
        />
      )}
    </div>
  );
}
