import { useRef, useState } from 'react';

/* Call-recording player: one button, a progress ring around it, elapsed time.
   Replaces the browser's native <audio controls> (a different widget per browser,
   far too wide for the Call Log cell). The <audio> element still does the real
   work — it just isn't drawing itself. */

const R = 16;                 // ring radius in the 36×36 viewBox
const C = 2 * Math.PI * R;    // circumference — the dash length we offset

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const IconPlay = () => (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" style={{ marginLeft: 1.5 }}>
    <path d="M8 5v14l11-7z" />
  </svg>
);
const IconPause = () => (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
    <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
  </svg>
);

export default function RecordingPlayer({ src, size = 34, total = 0 }) {
  const ref = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [err, setErr] = useState(false);

  // Bonvoice streams some files without a length, so duration can be Infinity/NaN —
  // guard it or the ring renders NaN into the DOM.
  const pct = dur > 0 && isFinite(dur) ? Math.min(1, t / dur) : 0;

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      // The list shows ~50 calls. Without this every press stacks another recording.
      document.querySelectorAll('audio').forEach((a) => a !== el && a.pause());
      el.play().catch(() => setErr(true));
    } else {
      el.pause();  // pause, not stop — keeps your place mid-call
    }
  };

  if (err) return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>unavailable</span>;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <audio
        ref={ref}
        src={src}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onEnded={() => { setPlaying(false); setT(0); }}
        onError={() => setErr(true)}
      />
      <button
        type="button"
        onClick={toggle}
        title={playing ? 'Pause recording' : 'Play recording'}
        aria-label={playing ? 'Pause recording' : 'Play recording'}
        style={{
          position: 'relative', width: size, height: size, flex: 'none', padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)',
        }}
      >
        <svg viewBox="0 0 36 36" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          <circle cx="18" cy="18" r={R} fill="none" stroke="var(--border)" strokeWidth="2.5" />
          <circle
            cx="18" cy="18" r={R} fill="none"
            stroke="var(--green)" strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - pct)}
            transform="rotate(-90 18 18)"
            style={{ transition: 'stroke-dashoffset .12s linear' }}
          />
        </svg>
        {playing ? <IconPause /> : <IconPlay />}
      </button>
      <span style={{ fontFamily: "'Spline Sans Mono', monospace", fontSize: 12, color: 'var(--text-muted)' }}>
        {/* elapsed / total — the total only shows where a `total` is passed in (the
            modal/drawer call-activity card), never in the log tables. Uses the audio's
            own length for accuracy once loaded, else the passed call duration. */}
        {fmt(t)}{(() => {
          if (!(Number(total) > 0)) return '';
          const tot = dur > 0 && isFinite(dur) ? dur : Number(total);
          return ` / ${fmt(tot)}`;
        })()}
      </span>
    </span>
  );
}
