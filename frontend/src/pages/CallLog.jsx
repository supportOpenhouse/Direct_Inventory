import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { toast } from '../utils/toast.js';
import RecordingPlayer from '../components/RecordingPlayer.jsx';
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
      <div className="al-head">
        <div><div className="al-subtitle">Every call Bonvoice has reported</div></div>
        <div className="al-result-count">{total.toLocaleString('en-IN')} call{total === 1 ? '' : 's'}{loading ? ' · …' : ''}</div>
      </div>

      <div className="al-filters">
        <input className="al-filter-input" placeholder="Search phone (any format) / lead name…"
          value={q} onChange={(e) => reset(() => setQ(e.target.value))} />
        <select className="al-filter-select" value={conn} onChange={(e) => reset(() => setConn(e.target.value))}>
          <option value="">Outcome</option>
          <option value="Connected">Connected</option>
          <option value="Not connected">Not connected</option>
        </select>
        <select className="al-filter-select" value={by} onChange={(e) => reset(() => setBy(e.target.value))}>
          <option value="">Placed by</option>
          <option value={BY_LEAD}>By Lead</option>
          <option value={BY_UNKNOWN}>Unknown</option>
          {actors.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select className="al-filter-select" value={dur} onChange={(e) => reset(() => setDur(e.target.value))}>
          <option value="">Duration</option>
          {DURATIONS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        {anyFilter && (
          <button className="btn-ghost" onClick={() => { setQ(''); setConn(''); setBy(''); setDur(''); setPage(0); }}>Clear</button>
        )}
        <div className="al-date-range">
          <span className="al-date-lbl">SYNC</span>
          <input type="date" className="al-date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} title="Sync from" />
          <span className="al-date-sep">to</span>
          <input type="date" className="al-date" value={to} min={from} onChange={(e) => setTo(e.target.value)} title="Sync to" />
        </div>
        <button className="btn-primary" onClick={runSync} disabled={syncing}
          title="Pull Bonvoice's own call records for this date range">
          {syncing ? 'Syncing…' : 'Sync from Bonvoice'}
        </button>
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
              <tr><td colSpan={7} className="al-empty">Loading calls…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={7} className="al-empty">{anyFilter ? 'No calls match these filters.' : 'No calls logged yet.'}</td></tr>
            ) : (
              items.map((c) => (
                <tr key={`${c.call_id}-${c.leg}`}>
                  <td className="al-ts">{formatCallTime(c.start_at) || '—'}</td>
                  <td>
                    {c.oh_id ? (
                      <>
                        <span>{c.lead_name || c.oh_id}</span>
                        {c.lead_side === 'from' && <span className="muted" style={{ fontSize: 11.5, marginLeft: 6 }}>(incoming)</span>}
                      </>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td style={{ fontFamily: "'Spline Sans Mono', monospace", fontSize: 12, whiteSpace: 'nowrap' }}>
                    {c.source_number || '—'} → {c.destination_number || '—'}
                  </td>
                  <td style={{ fontSize: 12.5 }}>
                    <span className={c.answered ? 'cat-pill cat-sync' : 'cat-pill cat-default'}>
                      {c.answered ? 'connected' : 'not connected'}
                    </span>{' '}
                    <span className="muted" style={{ fontSize: 11.5 }}>{c.status || c.agent_status || ''}</span>
                  </td>
                  <td style={{ fontFamily: "'Spline Sans Mono', monospace", fontSize: 12 }}>{callDuration(c.start_at, c.end_at)}</td>
                  <td>{c.recording_url ? <RecordingPlayer src={c.recording_url} /> : <span className="muted">—</span>}</td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {/* Inbound has no placed_by — the lead dialled, so credit them. */}
                    {c.lead_side === 'from' && c.oh_id ? (c.lead_name || c.oh_id) : (c.placed_by || '—')}
                  </td>
                </tr>
              ))
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
    </div>
  );
}
