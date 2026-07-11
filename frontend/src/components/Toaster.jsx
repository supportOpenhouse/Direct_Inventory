import { useEffect, useState } from 'react';
import { TOAST_EVENT } from '../utils/toast.js';

let idSeq = 0;

// Top-right toast stack. Errors linger (7s) and must be seen; success/info are
// brief. Clicking (or the ×) dismisses. At most 4 show at once.
export default function Toaster() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    function onToast(e) {
      const { message, type = 'info', duration } = e.detail || {};
      if (!message) return;
      const id = ++idSeq;
      setToasts((t) => [...t, { id, message, type }].slice(-4));
      const ttl = duration ?? (type === 'error' ? 7000 : 2800);
      if (ttl > 0) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
    }
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  const dismiss = (id) => setToasts((t) => t.filter((x) => x.id !== id));

  if (!toasts.length) return null;
  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`} role="status" onClick={() => dismiss(t.id)}>
          <span className="toast-ic">{t.type === 'error' ? '⚠' : t.type === 'success' ? '✓' : 'ℹ'}</span>
          <span className="toast-msg">{t.message}</span>
          <button className="toast-x" aria-label="Dismiss" onClick={(e) => { e.stopPropagation(); dismiss(t.id); }}>×</button>
        </div>
      ))}
    </div>
  );
}
