import { useEffect, useState } from 'react';

/**
 * Global "Saving…" overlay — appears while any write (POST/PATCH/PUT/DELETE)
 * is awaiting its response, so saves, ticket closes, visit scheduling etc.
 * always show feedback and can't be double-clicked. Waits 200ms before
 * showing so fast responses never flash.
 */
export default function BusyOverlay() {
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onBusy = (e) => setBusy((e.detail || 0) > 0);
    window.addEventListener('api:busy', onBusy);
    return () => window.removeEventListener('api:busy', onBusy);
  }, []);

  useEffect(() => {
    if (!busy) { setShow(false); return undefined; }
    const t = setTimeout(() => setShow(true), 200);
    return () => clearTimeout(t);
  }, [busy]);

  if (!show) return null;
  return (
    <div className="busy-overlay" role="status" aria-live="polite">
      <div className="busy-card"><span className="busy-spinner" />Saving…</div>
    </div>
  );
}
