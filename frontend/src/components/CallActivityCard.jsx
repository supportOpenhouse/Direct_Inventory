import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import RecordingPlayer from './RecordingPlayer.jsx';
import { callDuration, formatCallTime } from '../utils/format.js';

/* Calls placed to one lead, inside the row's expand panel — newest first, with the
   recording where Bonvoice kept one. Renders nothing until a call has been made:
   an empty section on a lead nobody has rung is just noise. */
export default function CallActivityCard({ ohId }) {
  const [calls, setCalls] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get(`/api/bonvoice/leads/${encodeURIComponent(ohId)}/calls`)
      .then((r) => { if (alive) setCalls(r.items || []); })
      .catch(() => { if (alive) setCalls([]); });
    return () => { alive = false; };
  }, [ohId]);

  if (!calls || calls.length === 0) return null;  // hidden until there's a call

  return (
    <div className="expand-sec expand-sec-wide" style={{ minWidth: 320, flexBasis: 320 }}>
      <h4>📞 Call activity <span className="muted" style={{ fontWeight: 400 }}>· {calls.length}</span></h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 320, overflowY: 'auto' }}>
        {calls.map((c) => (
          <div key={`${c.call_id}-${c.leg}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className={c.answered ? 'cat-pill cat-sync' : 'cat-pill cat-default'}>
                {c.answered ? 'connected' : 'not connected'}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{formatCallTime(c.start_at) || '—'}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: "'Spline Sans Mono', monospace", marginLeft: 'auto' }}>
                {callDuration(c.start_at, c.end_at)}
              </span>
            </div>
            {/* Streams straight off Bonvoice's url. Zero-duration calls have no file. */}
            {c.recording_url && <RecordingPlayer src={c.recording_url} />}
          </div>
        ))}
      </div>
    </div>
  );
}
