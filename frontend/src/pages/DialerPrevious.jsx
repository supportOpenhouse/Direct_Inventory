import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { toast } from '../utils/toast.js';
import RecordingPlayer from '../components/RecordingPlayer.jsx';
import { callDuration, formatCallTime } from '../utils/format.js';

/* Auto Dialer · Previous Campaigns — pick a campaign, see what it was set to, how it
   did, and every call it placed. The call table is the Bonvoice Call Log's own endpoint
   with a campaign_id filter, so the rows can't drift from what that page shows. */

const PAGE = 50;
const STATUS_TONE = { running: 'var(--green)', paused: 'var(--amber)', done: 'var(--text-muted)', draft: 'var(--text-muted)' };
const STRATEGY_LABEL = { assigned: 'Assigned leads', round_robin: 'Round-robin', least_load: 'Least load' };
const OP_PHRASE = { 'IN': 'is any of', 'NOT IN': 'is none of', 'BETWEEN': 'between', 'IS': 'is' };
const RINGING_GRACE_MS = 90000;

const outcomeColor = (r) => r.status === 'dialing' ? 'var(--amber)' : r.status === 'failed' ? 'var(--red)' : r.answered ? 'var(--green)' : 'var(--text-muted)';
const outcomeText = (r) => {
  if (r.status === 'failed') return r.detail || 'Not placed';
  if (r.status !== 'dialing') return r.answered ? 'Connected' : (r.outcome || 'No answer');
  const ringingFor = r.dialed_at ? Date.now() - new Date(r.dialed_at).getTime() : 0;
  return ringingFor > RINGING_GRACE_MS ? 'Ringing… (no hangup callback yet)' : 'Ringing…';
};
const hhmm = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '';

// A field with no value compiles to TRUE (filters nothing) — "any" is the honest reading.
function condText(node, f) {
  const label = f?.label || String(node.field).replace(/_/g, ' ').replace(/^./, (s) => s.toUpperCase());
  const v = node.value;
  if (Array.isArray(v)) {
    if (node.op === 'BETWEEN') { const [a, b] = v; return { label, phrase: a || b ? `between ${a || '…'} and ${b || '…'}` : 'any date', chips: [] }; }
    return v.length ? { label, phrase: OP_PHRASE[node.op] || node.op, chips: v } : { label, phrase: 'any value', chips: [] };
  }
  if (typeof v === 'boolean') return { label, phrase: `is ${v ? 'yes' : 'no'}`, chips: [] };
  return { label, phrase: `${node.op} ${v}`, chips: [] };
}

function RuleView({ node, fields }) {
  if (!node) return <div className="dl-empty">—</div>;
  if (node.type === 'condition') {
    const { label, phrase, chips } = condText(node, fields.find((f) => f.key === node.field));
    return <div className="rv-cond"><b>{label}</b> <span className="rv-op">{phrase}</span>{chips.map((c) => <span key={c} className="rv-chip">{c}</span>)}</div>;
  }
  if (!node.children?.length) return <div className="rv-cond"><span className="rv-op">No conditions — matched every lead.</span></div>;
  return (
    <div className="rv-group">
      <div className="rv-comb">Match {node.combinator === 'AND' ? 'all' : 'any'} of</div>
      <div className="rv-kids">{node.children.map((c) => <RuleView key={c.id} node={c} fields={fields} />)}</div>
    </div>
  );
}

const Tile = ({ n, label, hint }) => <div className="dl-stat" title={hint}><b>{n}</b><span>{label}</span></div>;

export default function DialerPrevious() {
  const [items, setItems] = useState(null);   // null=loading, []=none, [..]=list
  const [err, setErr] = useState('');
  const [rmMeta, setRmMeta] = useState({});   // email -> name
  const [fields, setFields] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [detail, setDetail] = useState(null); // {campaign, stats, per_rm, feed}
  const [calls, setCalls] = useState({ items: [], total: 0, loading: true });
  const [page, setPage] = useState(0);

  const loadList = () => api.get('/api/dialer/campaigns', { fresh: true })
    .then((r) => setItems(r.items))
    .catch((e) => { setItems([]); setErr(e?.status === 403 ? 'admin' : (e?.data?.error || e?.message)); });

  useEffect(() => {
    loadList();
    api.get('/api/dialer/fields').then((m) => {
      setFields(m.fields || []);
      setRmMeta(Object.fromEntries((m.rms || []).map((r) => [r.email, r.name])));
    }).catch(() => {});
  }, []);

  // Land on the newest campaign once the list loads (only while nothing is picked).
  useEffect(() => { if (!activeId && items?.length) setActiveId(items[0].id); }, [activeId, items]);

  // Detail + live feed: poll every 3s while the picked campaign is running.
  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    const load = () => api.get(`/api/dialer/campaigns/${activeId}`, { fresh: true })
      .then((d) => { if (alive) setDetail(d); }).catch(() => {});
    load();
    const id = setInterval(() => { if (!document.hidden && detail?.campaign?.status === 'running') load(); }, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [activeId, detail?.campaign?.status]);

  // Calls attributed to this campaign — the Call Log endpoint, campaign-scoped.
  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    setCalls((c) => ({ ...c, loading: true }));
    api.get(`/api/bonvoice/calls?campaign_id=${activeId}&limit=${PAGE}&offset=${page * PAGE}`, { fresh: true })
      .then((r) => { if (alive) setCalls({ items: r.items || [], total: r.total || 0, loading: false }); })
      .catch(() => { if (alive) setCalls({ items: [], total: 0, loading: false }); });
    return () => { alive = false; };
  }, [activeId, page]);

  const pick = (id) => { setActiveId(id); setPage(0); setDetail(null); };

  async function act(a) {
    if (!activeId) return;
    try {
      await api.post(`/api/dialer/campaigns/${activeId}/${a}`, null, { silent: true });
      api.get(`/api/dialer/campaigns/${activeId}`, { fresh: true }).then(setDetail).catch(() => {});
      loadList();
    } catch (e) {
      toast(e?.data?.error || e?.message || 'Action failed', 'error');
    }
  }

  if (items === null) return <div className="card dl-empty" style={{ padding: 28 }}>Loading campaigns…</div>;
  if (err === 'admin') return <div className="card dl-empty" style={{ padding: 28 }}>The auto dialer is admin-only — it rings other people's phones.</div>;
  if (err) return <div className="card dl-empty" style={{ padding: 28 }}>{err}</div>;
  if (!items.length) return <div className="card dl-empty" style={{ padding: 28 }}>No campaigns yet. Schedule one from Auto Dialer → Schedule Campaign.</div>;

  const c = detail?.campaign;
  const stats = detail?.stats || {};
  const perRM = detail?.per_rm || {};
  const feed = detail?.feed || [];
  const isLive = c?.status === 'running' || c?.status === 'paused';
  const running = c?.status === 'running';
  const total = calls.total;
  const start = total === 0 ? 0 : page * PAGE + 1;
  const end = Math.min(total, (page + 1) * PAGE);

  return (
    <div className="dl-prev">
      <aside className="dl-side">
        {isLive && (
          <>
            <div className="card dl-livecard">
              <div className="dl-livehead">
                <span className={'dl-livedot' + (running ? ' on' : '')} />
                {running ? 'Dialing live' : 'Campaign paused'}
              </div>
              <div className="dl-stats">
                <div className="dl-stat"><b>{stats.pending ?? 0}</b><span>In queue</span></div>
                <div className="dl-stat"><b>{stats.live ?? 0}</b><span>On call</span></div>
                <div className="dl-stat"><b>{(stats.done ?? 0) + (stats.failed ?? 0)}</b><span>Done</span></div>
              </div>
            </div>
            <div className="card dl-card">
              <div className="dl-eyebrow">Relationship managers</div>
              <div className="dl-rmlist">
                {(c?.rms || []).map((email) => {
                  const onCall = !!perRM[email]?.live;
                  return (
                    <div key={email} className="dl-rmrow">
                      <span className={'dl-statdot' + (onCall ? ' pulse' : '')} style={{ background: onCall ? 'var(--amber)' : 'var(--green)' }} />
                      <div className="dl-rmmeta"><b>{rmMeta[email] || email}</b><span>{onCall ? 'On a call' : running ? 'Waiting for the next lead' : 'Idle'}</span></div>
                      <span className="dl-donebadge">{perRM[email]?.done ?? 0}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="card dl-card">
              <div className="dl-eyebrow">Recent calls</div>
              <div className="dl-feed">
                {!feed.length && <div className="dl-empty">No calls yet.</div>}
                {feed.map((r) => (
                  <div key={r.oh_id + (r.dialed_at || '')} className="dl-feedrow">
                    <span className="dl-feeddot" style={{ background: outcomeColor(r) }} />
                    <div className="dl-rmmeta"><b>{r.lead_name || r.society || 'Lead'}</b><span>{rmMeta[r.rm_email || ''] || r.rm_email} · {outcomeText(r)}</span></div>
                    <span className="dl-feedtime">{hhmm(r.ended_at || r.dialed_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        <div className="card dl-card">
          <div className="dl-eyebrow">Campaigns</div>
          <div className="dl-rmlist">
            {items.map((r) => (
              <button key={r.id} type="button" className={'dl-camprow' + (r.id === activeId ? ' on' : '')} onClick={() => pick(r.id)}>
                <span className="dl-statdot" style={{ background: STATUS_TONE[r.status] || 'var(--text-muted)' }} />
                <div className="dl-rmmeta">
                  <b>{r.name}</b>
                  <span>{r.status} · {r.unique_leads} lead{r.unique_leads === 1 ? '' : 's'}{r.total_calls > r.unique_leads ? ` · ${r.total_calls} calls` : ''}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="dl-main">
        <section className="card dl-card">
          <div className="dl-cardhead">
            <div><div className="dl-eyebrow">Summary</div><h2 className="dl-cardtitle">{c?.name || '—'}</h2></div>
            {isLive ? (
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="btn-ghost" onClick={() => act(running ? 'pause' : 'start')}>{running ? 'Pause' : 'Resume'}</button>
                <button className="btn-ghost" onClick={() => { if (window.confirm('Cancel this campaign? Any calls already ringing finish, pending leads are dropped, and it can’t be resumed.')) act('stop'); }}>Cancel campaign</button>
              </span>
            ) : <span className="dl-count">{c?.started_at ? formatCallTime(c.started_at) : 'never started'}</span>}
          </div>
          <div className="dl-stats" style={{ marginBottom: 12 }}>
            <Tile n={stats.unique_leads ?? 0} label="Unique leads called" hint="A lead rung three times counts once here" />
            <Tile n={stats.total_calls ?? 0} label="Total calls placed" hint="Every attempt, retries included" />
            <Tile n={stats.connected ?? 0} label="Connected" />
          </div>
          {stats.total_calls > stats.unique_leads && (
            <p className="dl-note"><b>{stats.total_calls - stats.unique_leads}</b> of these were repeat attempts — up to {c?.max_attempts} per lead, {c?.cooldown_minutes} minutes apart.</p>
          )}
        </section>

        <section className="card dl-card">
          <div className="dl-cardhead">
            <div><div className="dl-eyebrow">Setup</div><h2 className="dl-cardtitle">Campaign instructions</h2></div>
            <span className="dl-count"><b>{stats.targeted ?? 0}</b> targeted leads</span>
          </div>
          <div className="dl-substep">Who to call</div>
          <RuleView node={c?.rules} fields={fields} />
          <div className="dl-substep divider">Who calls them, and how fast</div>
          <div className="dl-settings">
            <label className="dl-field"><span>Who called</span>
              <input className="dl-input" disabled value={STRATEGY_LABEL[c?.strategy] || c?.strategy || '—'} />
              <em className="dl-hint">{(c?.rms || []).join(', ') || 'no RMs'}</em>
            </label>
            <label className="dl-field"><span>Calling window (IST)</span>
              <input className="dl-input" disabled value={`${c?.window_start ?? '—'} – ${c?.window_end ?? '—'}`} />
            </label>
            <label className="dl-field"><span>Gap between calls</span>
              <input className="dl-input" disabled value={c ? `${c.gap_seconds}s` : '—'} />
            </label>
            <label className="dl-field"><span>Attempts / cooldown</span>
              <input className="dl-input" disabled value={c ? `${c.max_attempts} · ${c.cooldown_minutes} min` : '—'} />
            </label>
          </div>
        </section>

        <section className="card dl-card">
          <div className="dl-cardhead">
            <div><div className="dl-eyebrow">Calls placed</div></div>
            <span className="dl-count">{calls.loading ? 'loading…' : `${total} leg${total === 1 ? '' : 's'}`}</span>
          </div>
          <div className="al-table-wrap">
            <table className="al-table">
              <thead><tr>
                <th className="al-th" style={{ width: 130 }}>When</th>
                <th className="al-th">Lead</th>
                <th className="al-th">From → To</th>
                <th className="al-th">Status</th>
                <th className="al-th" style={{ width: 70 }}>Duration</th>
                <th className="al-th" style={{ width: 120 }}>Recording</th>
                <th className="al-th">Placed by</th>
              </tr></thead>
              <tbody>
                {calls.loading ? (
                  <tr><td colSpan={7} className="al-empty">Loading calls…</td></tr>
                ) : calls.items.length === 0 ? (
                  <tr><td colSpan={7} className="al-empty">No calls attributed to this campaign.{stats.total_calls ? ' Calls placed before campaign tracking was added aren’t attributed.' : ''}</td></tr>
                ) : calls.items.map((r) => (
                  <tr key={`${r.call_id}-${r.leg}`}>
                    <td className="al-ts">{formatCallTime(r.start_at) || '—'}</td>
                    <td>{r.oh_id ? (r.lead_name || r.oh_id) : <span className="muted">—</span>}</td>
                    <td style={{ fontFamily: "'Spline Sans Mono', monospace", fontSize: 12, whiteSpace: 'nowrap' }}>{r.source_number || '—'} → {r.destination_number || '—'}</td>
                    <td style={{ fontSize: 12.5 }}>
                      <span className={r.answered ? 'cat-pill cat-sync' : 'cat-pill cat-default'}>{r.answered ? 'connected' : 'not connected'}</span>{' '}
                      <span className="muted" style={{ fontSize: 11.5 }}>{r.status || r.agent_status || ''}</span>
                    </td>
                    <td style={{ fontFamily: "'Spline Sans Mono', monospace", fontSize: 12 }}>
                      {r.recording_url
                        ? <a className="inv-link" href={r.recording_url} target="_blank" rel="noreferrer" title="Open recording in a new tab">{callDuration(r.start_at, r.end_at)}</a>
                        : callDuration(r.start_at, r.end_at)}
                    </td>
                    <td>{r.recording_url ? <RecordingPlayer src={r.recording_url} /> : <span className="muted">—</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}><span style={{ textDecoration: 'underline' }}>{r.lead_name || r.oh_id || '—'}</span> → <b>{r.rm_name || r.placed_by || '—'}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
            <span className="muted" style={{ fontSize: 12 }}>{total > 0 ? `${start}–${end} of ${total.toLocaleString('en-IN')}` : '—'}</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="btn-ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
              <button className="btn-ghost" disabled={end >= total} onClick={() => setPage((p) => p + 1)}>Next →</button>
            </span>
          </div>
        </section>
      </main>
    </div>
  );
}
