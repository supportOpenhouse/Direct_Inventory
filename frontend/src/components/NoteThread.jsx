import { useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';

// Deterministic avatar tint per identity.
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
function Avatar({ name, email, sizeClass = '' }) {
  return (
    <span className={`note-av ${sizeClass}`.trim()} style={avatarStyle(email || name)}>
      {initialsOf(name, email)}
    </span>
  );
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

/**
 * Multi-author notes thread. Reads/writes inventory.note_thread (JSONB array)
 * via POST /api/inventory/:ohId/notes. Used inside the expand panel and the
 * card detail modal.
 */
export default function NoteThread({ ohId, initial = [], canPost = true, onChange }) {
  const { user } = useAuth();
  const [notes, setNotes] = useState(() => (Array.isArray(initial) ? [...initial] : []));
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState(null);

  const ordered = [...notes].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  async function send() {
    const text = draft.trim();
    if (!text || posting) return;
    setError(null);
    setPosting(true);
    try {
      const r = await api.post(`/api/inventory/${ohId}/notes`, { body: text });
      const next = r.note_thread || [...notes, r.note];
      setNotes(next);
      setDraft('');
      onChange?.(next);
    } catch (e) {
      setError(e?.data?.error || e?.message || 'Failed to post note');
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="note-thread">
      <div className="note-thread-head">
        <strong>Notes</strong>
        <span className="note-thread-count">{ordered.length}</span>
      </div>
      <ul className="note-list">
        {ordered.length === 0 && !canPost && <li className="note-empty muted">No notes yet.</li>}
        {ordered.map((n) => (
          <li key={n.id} className="note-item">
            <Avatar name={n.author_name} email={n.author_email} />
            <div className="note-body">
              <div className="note-meta">
                <strong>{n.author_name || n.author_email}</strong>
                <span className="note-time">{fmtTime(n.created_at)}</span>
              </div>
              <div className="note-text">{n.body}</div>
            </div>
          </li>
        ))}
        {canPost && (
          <li className="note-item">
            <Avatar name={user?.name} email={user?.email} />
            <div className="note-body">
              <div className="note-input-row">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                  placeholder="Add a note…"
                  disabled={posting}
                />
                <button type="button" className="note-send" onClick={send} disabled={posting || !draft.trim()} title="Send">➤</button>
              </div>
              {error && <div className="note-error">{error}</div>}
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}
