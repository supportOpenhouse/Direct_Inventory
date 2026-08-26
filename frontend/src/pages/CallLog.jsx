import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client.js';
import { TableLoader } from '../components/TruckLoader.jsx';
import { toast } from '../utils/toast.js';
import RecordingPlayer from '../components/RecordingPlayer.jsx';
import CardDetailModal from '../components/CardDetailModal.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { IconSearch } from '../components/icons.jsx';
import { callDuration, formatCallTime } from '../utils/format.js';

/* Bonvoice Call Log — every call Bonvoice has reported, with its recording.
   Rows are legs, not calls: a live bridged call writes one for the RM's handset and
   one for the lead. The leg itself isn't shown — it's noise next to the numbers. */

const PAGE = 50;
// Server sentinels — mirror PLACED_BY_LEAD / PLACED_BY_UNKNOWN in api/bonvoice.py.
const BY_LEAD = 'by-lead';
const BY_UNKNOWN = 'unknown';
const DURATIONS = ['<1 min', '1-3 mins', '3-5 mins', '5+ mins'];
const ymd = (d) => d.toISOString().slice(0, 10);

// Capitalize the first letter of each segment (split on space or '.'), strip any
// email domain: "a.gupta@openhouse.in" → "A.Gupta", "arti ahirwar" → "Arti Ahirwar".
function capName(s) {
  if (!s) return '';
  return String(s).split('@')[0].replace(/(^|[.\s])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

export default function CallLog() {
  const [q, setQ] = useState('');
  const [conn, setConn] = useState('');
  const [by, setBy] = useState('');
  const [dur, setDur] = useState('');
  const [page, setPage] = useState(0);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actors, setActors] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [nonce, setNonce] = useState(0);   // bumped after a sync to force a refetch
  const { user } = useAuth();
  const [detail, setDetail] = useState(null);  // property popup, opened from a lead name
  // The "Sync from Bonvoice" button is rendered (via portal) into the topbar strip,
  // left of the incoming-calls bell — while keeping its state/handler here.
  const [topbarSlot, setTopbarSlot] = useState(null);
  useEffect(() => { setTopbarSlot(document.getElementById('topbar-slot')); }, []);

  // Open the property detail popup for an oh_id — same flow as the Activity Logs UID.
  function openUid(uid) {
    setDetail({ oh_id: uid, _loading: true });
    api.get(`/api/inventory/${encodeURIComponent(uid)}`)
      .then((r) => setDetail((prev) => (prev && prev.oh_id === uid ? r : prev)))
      .catch(() => setDetail((prev) => (prev && prev.oh_id === uid ? { ...prev, _loading: false } : prev)));
  }

  // Backfill window — last 30 days by default, the usual "why isn't that call here?"
  // range. Bonvoice holds the full history if you widen it.
  const [from, setFrom] = useState(() => ymd(new Date(Date.now() - 30 * 864e5)));
  const [to, setTo] = useState(() => ymd(new Date()));

  const reset = (fn) => { fn(); setPage(0); };
  const anyFilter = q || conn || by || dur;

  useEffect(() => {
    api.get('/api/bonvoice/calls/actors').then((r) => setActors(r.items || [])).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (conn) p.set('answered', conn === 'Connected' ? 'true' : 'false');
    if (by) p.set('placed_by', by);
    if (dur) p.set('duration', dur);
    p.set('limit', String(PAGE));
    p.set('offset', String(page * PAGE));
    // debounce the free-text search so each keystroke isn't a request
    const t = setTimeout(() => {
      api.get(`/api/bonvoice/calls?${p}`)
        .then((r) => { if (alive) { setItems(r.items || []); setTotal(r.total || 0); } })
        .catch(() => { if (alive) { setItems([]); setTotal(0); } })
        .finally(() => { if (alive) setLoading(false); });
    }, q ? 300 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [q, conn, by, dur, page, nonce]);

  async function runSync() {
    setSyncing(true);
    try {
      const r = await api.post(`/api/bonvoice/calls/sync?from=${from}&to=${to}`, null, { silent: true });
      toast(`Synced ${r.stored} of ${r.fetched} call records`, 'success');
      setPage(0);
      setNonce((n) => n + 1);   // refetch (cache was already cleared by the write)
      api.get('/api/bonvoice/calls/actors').then((x) => setActors(x.items || [])).catch(() => {});
    } catch (e) {
      toast(e?.data?.error || e?.message || 'Sync failed', 'error');
    } finally {
      setSyncing(false);
    }
  }

  const start = total === 0 ? 0 : page * PAGE + 1;
  const end = Math.min(total, (page + 1) * PAGE);

  return (
    <div>
      {/* Sync button lives in the topbar strip (portaled), left of the incoming-calls bell. */}
      {topbarSlot && user?.role === 'admin' && createPortal(
        <button className="btn-primary" onClick={runSync} disabled={syncing}
          title="Pull Bonvoice's own call records for this date range">
          {syncing ? 'Syncing…' : 'Sync from Bonvoice'}
        </button>,
        topbarSlot,
      )}

      <div className="al-filters">
        <div className="al-search-wrap">
          <span className="al-search-icon"><IconSearch size={15} /></span>
          <input className="al-filter-input" placeholder="Search phone (any format) / lead name…"
            value={q} onChange={(e) => reset(() => setQ(e.target.value))} />
        </div>
        <select className="al-filter-select" value={conn} onChange={(e) => reset(() => setConn(e.target.value))}>
          <option value="">Outcome</option>
          <option value="Connected">Connected</option>
          <option value="Not connected">Not connected</option>
        </select>
        <select className="al-filter-select" value={by} onChange={(e) => reset(() => setBy(e.target.value))}>
          <option value="">Placed by</option>
          <option value={BY_LEAD}>By Lead</option>
          <option value={BY_UNKNOWN}>Unknown</option>
          {actors.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
        <select className="al-filter-select" value={dur} onChange={(e) => reset(() => setDur(e.target.value))}>
          <option value="">Duration</option>
          {DURATIONS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        {anyFilter && (
          <button className="btn-ghost" onClick={() => { setQ(''); setConn(''); setBy(''); setDur(''); setPage(0); }}>Clear</button>
        )}
        {/* Backfill date range is admin-only (the endpoint requires admin). The Sync
            button itself is portaled to the topbar. */}
        {user?.role === 'admin' && (
          <div className="al-date-range">
            <span className="al-date-lbl">SYNC</span>
            <input type="date" className="al-date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} title="Sync from" />
            <span className="al-date-sep">to</span>
            <input type="date" className="al-date" value={to} min={from} onChange={(e) => setTo(e.target.value)} title="Sync to" />
          </div>
        )}
        {/* Result count — moved here from the old header, into the Sync button's old spot. */}
        <div className="al-result-count">{total.toLocaleString('en-IN')} call{total === 1 ? '' : 's'}{loading ? ' · …' : ''}</div>
      </div>

      <div className="al-table-wrap">
        <table className="al-table">
          <thead>
            <tr>
              <th className="al-th" style={{ width: 130 }}>When</th>
              <th className="al-th">Lead</th>
              <th className="al-th">From → To</th>
              <th className="al-th">Status</th>
              <th className="al-th" style={{ width: 70 }}>Duration</th>
              <th className="al-th" style={{ width: 120 }}>Recording</th>
              <th className="al-th">Placed by</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <TableLoader colSpan={7} label="Loading calls…" />
            ) : items.length === 0 ? (
              <tr><td colSpan={7} className="al-empty">{anyFilter ? 'No calls match these filters.' : 'No calls logged yet.'}</td></tr>
            ) : (
              items.map((c) => {
                // Incoming = the lead dialled in (lead is the source). Direction from the
                // PBX record; lead_side is the fallback for older rows.
                const incoming = (c.direction || '').toLowerCase().startsWith('in') || c.lead_side === 'from';
                const leadName = capName(c.lead_name) || c.oh_id || '—';
                const rmName = capName(c.rm_name) || capName(c.placed_by) || '—';
                // Lead name underlined, RM name bold — regardless of position.
                const leadEl = <span style={{ textDecoration: 'underline' }}>{leadName}</span>;
                const rmEl = <b>{rmName}</b>;
                return (
                  <tr key={`${c.call_id}-${c.leg}`}>
                    <td className="al-ts">{formatCallTime(c.start_at) || '—'}</td>
                    <td>
                      {c.oh_id ? (
                        <button type="button" className="al-uid-link" onClick={() => openUid(c.oh_id)}>{c.oh_id}</button>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      <span style={{ fontFamily: "'Spline Sans Mono', monospace" }}>{c.source_number || '—'} → {c.destination_number || '—'}</span>
                      <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>{incoming ? 'incoming' : 'outgoing'}</span>
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      <span className={c.answered ? 'cat-pill cat-sync' : 'cat-pill cat-default'}>
                        {c.answered ? 'connected' : 'not connected'}
                      </span>
                    </td>
                    <td style={{ fontFamily: "'Spline Sans Mono', monospace", fontSize: 12 }}>{callDuration(c.start_at, c.end_at)}</td>
                    <td>{c.recording_url ? <RecordingPlayer src={c.recording_url} /> : <span className="muted">—</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {/* placed by → placed to. Outgoing: RM placed it to the lead; incoming: lead placed it to the RM. */}
                      {incoming ? <>{leadEl} → {rmEl}</> : <>{rmEl} → {leadEl}</>}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {total > 0 ? `${start}–${end} of ${total.toLocaleString('en-IN')}` : '—'}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button className="btn-ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Prev</button>
          <button className="btn-ghost" disabled={end >= total} onClick={() => setPage((p) => p + 1)}>Next →</button>
        </span>
      </div>

      {detail && (
        <CardDetailModal item={detail} role={user?.role} showAssignedRm
          onUpdated={(u) => setDetail((p) => ({ ...p, ...u }))}
          onClose={() => setDetail(null)} />
      )}
    </div>
  );
}
