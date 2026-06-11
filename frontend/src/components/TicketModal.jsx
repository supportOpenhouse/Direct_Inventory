import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { IconClose } from './icons.jsx';

// Notify the rest of the app (nav dot, home card) that a ticket changed.
export function emitTicketsChanged() {
  window.dispatchEvent(new Event('tickets:changed'));
}

function initialsOf(name, email) {
  const s = (name || (email || '').split('@')[0] || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
function avatarStyle(key) {
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { background: `hsl(${hue}, 60%, 88%)`, color: `hsl(${hue}, 55%, 30%)` };
}
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

export function ticketStatusLabel(t) {
  if (t.status === 'closed') return 'Closed';
  if (t.awaiting === 'rm') return 'Awaiting RM';
  if (t.awaiting === 'creator') return 'Awaiting review';
  return 'Open';
}
export function ticketStatusClass(t) {
  if (t.status === 'closed') return 'tk-badge-closed';
  return t.awaiting === 'creator' ? 'tk-badge-review' : 'tk-badge-rm';
}

/**
 * Full conversation view for one ticket: the title/summary, the message thread,
 * a reply box (assigned RM / creator / admin), and close/reopen (creator/admin).
 * Refetches on mount so the thread is current. Calls onChanged(updated) and
 * fires `tickets:changed` after every mutation so hosts can patch in place.
 */
export default function TicketModal({ ticket, onChanged, onClose }) {
  const { user } = useAuth();
  const [t, setT] = useState(ticket);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get(`/api/tickets/${ticket.id}`).then((r) => { if (alive) setT(r); }).catch(() => {});
    return () => { alive = false; };
  }, [ticket.id]);

  const isAdmin = user?.role === 'admin';
  const isCreator = user?.id === t.created_by_id;
  const isAssignedRm = user?.id === t.assigned_rm_id;
  const isOpen = t.status === 'open';
  const canReply = isOpen && (isAdmin || isCreator || isAssignedRm);
  const canClose = isAdmin || isCreator;
  const messages = [...(t.messages || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  function apply(updated) { setT(updated); onChanged?.(updated); emitTicketsChanged(); }

  async function send() {
    const body = draft.trim();
    if (!body || busy) return;
    setError(null); setBusy(true);
    try {
      const r = await api.post(`/api/tickets/${t.id}/reply`, { body });
      apply(r); setDraft('');
    } catch (e) { setError(e?.data?.error || e?.message || 'Failed to reply'); }
    finally { setBusy(false); }
  }
  async function doClose() {
    setError(null); setBusy(true);
    try { apply(await api.post(`/api/tickets/${t.id}/close`, {})); }
    catch (e) { setError(e?.data?.error || e?.message); }
    finally { setBusy(false); }
  }
  async function doReopen() {
    setError(null); setBusy(true);
    try { apply(await api.post(`/api/tickets/${t.id}/reopen`, {})); }
    catch (e) { setError(e?.data?.error || e?.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head-row">
          <h3>{t.title}</h3>
          <span className={`tk-badge ${ticketStatusClass(t)}`}>{ticketStatusLabel(t)}</span>
          <button className="modal-close" onClick={onClose}><IconClose /></button>
        </div>
        <p className="modal-sub">
          {t.oh_id ? <>{t.society || '—'} · {t.oh_id}</> : <>Direct ticket</>}
          {t.assigned_rm_name && <> · RM: {t.assigned_rm_name}</>}
        </p>

        {t.summary && <div className="tk-summary">{t.summary}</div>}

        <div className="tk-thread">
          <div className="tk-thread-head">
            <strong>Conversation</strong>
            <span className="note-thread-count">{messages.length}</span>
          </div>
          <ul className="note-list">
            {messages.length === 0 && <li className="note-empty muted">No replies yet.</li>}
            {messages.map((m) => (
              <li key={m.id} className="note-item">
                <span className="note-av" style={avatarStyle(m.author_email || m.author_name)}>{initialsOf(m.author_name, m.author_email)}</span>
                <div className="note-body">
                  <div className="note-meta">
                    <strong>{m.author_name || m.author_email}</strong>
                    {m.author_role && <span className="tk-role">{m.author_role}</span>}
                    <span className="note-time">{fmtTime(m.created_at)}</span>
                  </div>
                  <div className="note-text">{m.body}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {error && <div className="modal-error">{error}</div>}

        {canReply && (
          <div className="note-input-row tk-reply">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Write a reply…"
              disabled={busy}
            />
            <button type="button" className="btn-primary" onClick={send} disabled={busy || !draft.trim()}>Reply</button>
          </div>
        )}
        {!isOpen && <div className="tk-closed-note muted">This ticket is closed.</div>}

        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          {isOpen && canClose && <button className="btn-soft" onClick={doClose} disabled={busy}>Close ticket</button>}
          {!isOpen && canClose && <button className="btn-soft" onClick={doReopen} disabled={busy}>Reopen</button>}
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Done</button>
        </div>
      </div>
    </div>
  );
}
