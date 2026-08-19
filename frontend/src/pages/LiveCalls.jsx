import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { toast } from '../utils/toast.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { formatCallTime } from '../utils/format.js';
import MissReasonModal from '../components/MissReasonModal.jsx';
import StatusEditModal from '../components/StatusEditModal.jsx';
import { IconCheck, IconClose, IconWarning } from '../components/icons.jsx';

/* Live Calls (RM) — who the dialer is ringing you right now, what's queued, and the
   disposition worklist for today's calls. Polls /my-calls every 4s (no SSE); marking a
   result refetches immediately so the badge clears without waiting for the next tick. */

const POLL_MS = 4000;

function details(l) {
  const bhk = l.configuration ? `${l.configuration} BHK` : '';
  const budget = l.budget ? `₹${Number(l.budget).toLocaleString('en-IN')}` : '';
  return [l.society, l.city, bhk, budget].filter(Boolean).join(' · ');
}

function NowCalling({ lead }) {
  if (!lead) {
    return (
      <div className="lc-card lc-idle">
        <div className="lc-eyebrow">No live call</div>
      </div>
    );
  }
  return (
    <div className="lc-card lc-live">
      <div className="lc-eyebrow lc-pulse"><span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",background:"currentColor"}} /> Now calling</div>
      <h2 className="lc-name">{lead.name || 'Unnamed lead'}</h2>
      {lead.phone && <div className="lc-phone">{lead.phone}</div>}
      <div className="lc-details">{details(lead)}</div>
      <div className="lc-meta">
        {lead.stage && <span className="chip">{lead.stage}</span>}
        <span className="lc-muted">
          {lead.ever_connected ? 'spoken to before' : `never reached${lead.miss_count ? ` · ${lead.miss_count} misses` : ''}`}
        </span>
      </div>
    </div>
  );
}

function Upcoming({ items, shared }) {
  if (!items.length) return null;
  return (
    <section className="lc-section">
      <h3>Up next</h3>
      {shared && <p className="lc-muted" style={{ marginTop: -4 }}>Shared pool — these may go to another RM.</p>}
      <ol className="lc-queue">
        {items.map((l) => (
          <li key={l.id}>
            <span className="lc-qname">{l.name || 'Unnamed lead'}</span>
            <span className="lc-muted">{details(l)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CompletedRow({ lead, onMark }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editItem, setEditItem] = useState(null);

  // Pull the full inventory record so the status modal (and its visit/reject sub-flows)
  // has every field; fall back to the row's own fields if the fetch is denied.
  async function openStatus() {
    try {
      const rec = await api.get(`/api/inventory/${encodeURIComponent(lead.oh_id)}`);
      setEditItem(rec?.item || rec || { oh_id: lead.oh_id, stage: lead.stage, society: lead.society });
    } catch {
      setEditItem({ oh_id: lead.oh_id, stage: lead.stage, society: lead.society });
    }
  }

  if (lead.call_result) {
    const ok = lead.call_result === 'connected';
    const retriesLeft = lead.retries_left || 0;
    // A missed call still has auto-redials → show how many; once none are left (or it
    // connected) the call is final, so offer a status change.
    const canChange = ok || retriesLeft === 0;
    return (
      <li className="lc-done">
        <span className="lc-qname">{lead.name || 'Unnamed lead'}</span>
        <span className="lc-muted">{formatCallTime(lead.dialed_at)}</span>
        <span className={ok ? 'lc-ok' : 'lc-miss'}>{ok ? <><IconCheck size={13} /> connected</> : <><IconClose size={13} /> not reached</>}</span>
        {!ok && retriesLeft > 0 && (
          <span className="lc-muted" style={{ fontSize: 11.5 }}>{retriesLeft} retr{retriesLeft === 1 ? 'y' : 'ies'} left</span>
        )}
        {canChange && <button className="cc-btn no" style={{ marginLeft: 8 }} onClick={openStatus}>Change status</button>}
        {editItem && (
          <StatusEditModal item={editItem}
            onClose={() => setEditItem(null)}
            onUpdated={() => { setEditItem(null); onMark(); }} />
        )}
      </li>
    );
  }

  async function yes() {
    setBusy(true);
    try {
      await api.post(`/api/live-calls/leads/${encodeURIComponent(lead.oh_id)}/result`,
        { connected: true, queue_item_id: lead.id }, { silent: true });
      toast('Marked connected', 'success');
      onMark();
    } catch (e) {
      toast(e?.data?.error || e?.message || 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="lc-pending">
      <span className="lc-qname">{lead.name || 'Unnamed lead'}</span>
      <span className="lc-muted">{formatCallTime(lead.dialed_at)}</span>
      <span className="lc-badge"><IconWarning size={13} /> needs result</span>
      <span className="cc">
        <span className="cc-q">Connected?</span>
        <button className="cc-btn yes" onClick={yes} disabled={busy}>Yes</button>
        <button className="cc-btn no" onClick={() => setAsking(true)} disabled={busy}>No</button>
      </span>
      {asking && (
        <MissReasonModal ohId={lead.oh_id} queueItemId={lead.id}
          onClose={() => setAsking(false)} onDone={onMark} />
      )}
    </li>
  );
}

export default function LiveCalls() {
  const { user } = useAuth();
  const isRm = user?.role === 'rm';
  const [data, setData] = useState(null);
  const alive = useRef(true);
  const seq = useRef(0);   // latest-issued load wins, whatever order responses land in

  const load = useCallback(() => {
    const my = ++seq.current;
    return api.get('/api/live-calls/my-calls', { fresh: true })
      .then((d) => { if (alive.current && my === seq.current) setData(d); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isRm) return undefined;
    alive.current = true;
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => { alive.current = false; clearInterval(id); };
  }, [isRm, load]);

  // After a mark, refetch AND nudge the sidebar badge to re-poll immediately (it
  // otherwise lags up to 15s — same in-tab write the ticket dot bridges).
  const onMarked = useCallback(() => { window.dispatchEvent(new Event('live-calls:changed')); load(); }, [load]);

  // Admins run campaigns, they don't take calls — bounce them home (our RequireAuth
  // lets admin through, so the real gate is here).
  if (!isRm) return <Navigate to="/" replace />;
  if (!data) return <div className="page"><p className="lc-muted">Loading…</p></div>;

  const completed = data.completed || [];
  const upcoming = data.upcoming || [];
  const unmarked = completed.filter((c) => !c.call_result).length;

  return (
    <div className="lc-page">
      <div className={'lc-incoming' + (data.now_calling ? ' live' : '')}>
        <strong>{upcoming.length}</strong> call{upcoming.length === 1 ? '' : 's'} incoming
        {data.upcoming_is_shared && upcoming.length > 0 && <span className="lc-muted"> · shared pool</span>}
      </div>

      <header className="lc-head">
        <h1>Live Calls</h1>
        {data.campaign
          ? <p className="lc-muted">{data.campaign.name} · {data.campaign.window_start}–{data.campaign.window_end} IST</p>
          : <p className="lc-muted">No campaign is dialling you right now.</p>}
      </header>

      <NowCalling lead={data.now_calling} />

      <Upcoming items={upcoming} shared={data.upcoming_is_shared} />

      <section className="lc-section">
        <h3>Today · {completed.length} call{completed.length === 1 ? '' : 's'}
          {unmarked > 0 && <span className="lc-badge"> {unmarked} need a result</span>}
        </h3>
        {completed.length
          ? <ul className="lc-list">{completed.map((c) => <CompletedRow key={c.id} lead={c} onMark={onMarked} />)}</ul>
          : <p className="lc-muted">Nothing dialled yet today.</p>}
      </section>
    </div>
  );
}
