import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { formatCallTime } from '../utils/format.js';
import { IconPhone } from './icons.jsx';

/* Top-bar bell for incoming Bonvoice calls (a lead ringing your DID → routed to you).
   Polls /api/bonvoice/incoming; each call stays until acknowledged, which clears the
   badge. Scoped server-side to the current user's own number. */
export default function IncomingCallBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const ref = useRef(null);

  async function refresh() {
    try { const r = await api.get('/api/bonvoice/incoming', { fresh: true }); setItems(r.items || []); }
    catch { /* non-blocking */ }
  }
  useEffect(() => {
    refresh();
    const id = setInterval(() => { if (!document.hidden) refresh(); }, 20000);
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
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function ack(callId) {
    setItems((prev) => prev.filter((c) => c.call_id !== callId));   // optimistic
    try { await api.post('/api/bonvoice/incoming/ack', { call_id: callId }, { silent: true }); }
    catch { refresh(); }
  }
  async function ackAll() {
    setItems([]);
    try { await api.post('/api/bonvoice/incoming/ack', {}, { silent: true }); }
    catch { refresh(); }
  }

  const count = items.length;

  return (
    <div className="bell-wrap" ref={ref}>
      <button type="button" className="icon-btn bell-btn" title="Incoming calls"
        aria-label={`Incoming calls: ${count}`} onClick={() => { setOpen((p) => !p); if (!open) refresh(); }}>
        <IconPhone />
        {count > 0 && <span className="bell-badge">{count > 99 ? '99+' : count}</span>}
      </button>

      {open && (
        <div className="bell-dropdown">
          <div className="bell-cat-head" style={{ cursor: 'default' }}>
            <span className="bell-cat-name">Incoming calls<span className="bell-section-hint">unacknowledged</span></span>
            {count > 0 && <button type="button" className="btn-link" onClick={ackAll}>Mark all read</button>}
          </div>
          <div className="bell-drawer">
            {count === 0
              ? <div className="bell-empty">No incoming calls.</div>
              : items.map((c) => (
                <div key={c.call_id} className="bell-row" style={{ cursor: 'default' }}>
                  <span className="bell-soc">{c.lead_name || c.source_number || 'Unknown caller'}</span>
                  <span className="bell-meta">{c.source_number || '—'}{c.start_at ? ` · ${formatCallTime(c.start_at)}` : ''}</span>
                  <button type="button" className="btn-link" onClick={() => ack(c.call_id)}>Acknowledge</button>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
