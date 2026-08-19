import { useState } from 'react';
import { api } from '../api/client.js';
import { toast } from '../utils/toast.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { IconPhone, IconPhoneOff } from './icons.jsx';

/**
 * Click-to-call. Bonvoice rings the caller's OWN phone first, then bridges the
 * lead in once they pick up — no audio in the browser, so the toast has to explain
 * the delay. `silent: true` skips the API layer's own toasts; we show our own.
 * Stops row-click propagation (rows navigate/expand on click). With no number on
 * file it shows a crossed-phone icon that just toasts "Phone No. Not Available".
 */
export default function CallButton({ ohId, phone, className = '' }) {
  const [busy, setBusy] = useState(false);
  const { user } = useAuth();

  if (!phone) {
    return (
      <button type="button" className={`call-btn call-btn-off ${className}`}
        onClick={(e) => { e.stopPropagation(); toast('Phone No. Not Available', 'error'); }}
        title="No phone number on file" aria-label="No phone number">
        <IconPhoneOff size={14} />
      </button>
    );
  }

  async function call(e) {
    e.stopPropagation();
    if (busy) return;
    // The call rings the caller's own phone — a non-RM dialling someone else's lead
    // should confirm they mean to.
    if (user?.role !== 'rm' && !window.confirm('You are not the RM. Still want to call?')) return;
    setBusy(true);
    try {
      const r = await api.post('/api/bonvoice/call', { oh_id: ohId }, { silent: true });
      toast(`Ringing your phone (${r.rm_phone_masked}) — pick up to connect`, 'info');
    } catch (err) {
      toast(err?.data?.error || err?.message || 'Call failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className={`call-btn ${className}`} onClick={call} disabled={busy}
      title="Call this lead (rings your phone first)" aria-label="Call lead">
      {busy ? <span className="btn-spinner" /> : <IconPhone size={14} />}
    </button>
  );
}
