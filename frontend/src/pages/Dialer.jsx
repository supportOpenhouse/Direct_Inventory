import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { toast } from '../utils/toast.js';

/* Auto Dialer · Schedule Campaign — build an AND/OR rule tree, pick the RM pool and
   pacing, and start dialling. The tree is untrusted input; the server re-compiles it
   through a whitelist (services/dialer.py), so this page only has to build valid JSON. */

let _n = 0;
const nid = () => `n${++_n}`;
const defaultValue = (f) => (f.kind === 'multi' ? [] : f.kind === 'number' ? 0 : f.kind === 'daterange' ? ['', ''] : false);
const emptyTree = () => ({ id: nid(), type: 'group', combinator: 'AND', children: [] });

function mapTree(node, fn) {
  const m = fn(node);
  return m.type === 'group' ? { ...m, children: m.children.map((c) => mapTree(c, fn)) } : m;
}
function removeById(node, id) {
  if (node.type !== 'group') return node;
  return { ...node, children: node.children.filter((c) => c.id !== id).map((c) => removeById(c, id)) };
}

const STRATEGIES = [
  { key: 'assigned', label: 'Assigned leads', hint: "Each RM calls only the leads they're assigned" },
  { key: 'round_robin', label: 'Round-robin', hint: 'Spread leads across the pool, longest-idle first' },
  { key: 'least_load', label: 'Least load', hint: 'Next lead goes to whoever has done the fewest' },
];

// Mirrors window_has_passed() in services/dialer.py — the server refuses it too; this
// just warns before the click. Malformed/inverted window is never "past".
function windowHasPassed(start, end) {
  const p = (s) => { const [h, m] = String(s).split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
  const s = p(start), e = p(end);
  if (s == null || e == null || e < s) return false;
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() > e;
}

function Condition({ node, fields, update, remove }) {
  const f = fields.find((x) => x.key === node.field) || fields[0];
  if (!f) return null;
  const val = node.value;
  return (
    <div className="dl-cond">
      <select className="dl-select" value={node.field}
        onChange={(e) => {
          const next = fields.find((x) => x.key === e.target.value);
          update(node.id, { field: next.key, op: next.ops[0], value: defaultValue(next) });
        }}>
        {fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
      </select>
      {f.ops.length > 1
        ? <select className="dl-select dl-op" value={node.op} onChange={(e) => update(node.id, { op: e.target.value })}>
            {f.ops.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        : <span className="dl-op-static">is between</span>}
      <div className="dl-val">
        {f.kind === 'multi' && (
          <div className="dl-pillrow">
            {f.options.length === 0 && <span className="dl-empty">no values in the data yet</span>}
            {f.options.map((o) => {
              const on = Array.isArray(val) && val.includes(o);
              return (
                <button key={o} type="button" className={'dl-pill' + (on ? ' on' : '')}
                  onClick={() => update(node.id, { value: on ? val.filter((x) => x !== o) : [...(val || []), o] })}>
                  {o}
                </button>
              );
            })}
          </div>
        )}
        {f.kind === 'number' && (
          <input type="number" className="dl-input" style={{ width: 90 }} value={String(val)}
            onChange={(e) => update(node.id, { value: Number(e.target.value) })} />
        )}
        {f.kind === 'daterange' && (
          <div className="dl-daterow">
            <input type="date" className="dl-input" value={(val || [])[0] || ''}
              onChange={(e) => update(node.id, { value: [e.target.value, (val || [])[1] || ''] })} />
            <span className="dl-dash">–</span>
            <input type="date" className="dl-input" value={(val || [])[1] || ''}
              onChange={(e) => update(node.id, { value: [(val || [])[0] || '', e.target.value] })} />
          </div>
        )}
        {f.kind === 'bool' && (
          <div className="dl-pillrow">
            {[true, false].map((b) => (
              <button key={String(b)} type="button" className={'dl-pill' + (Boolean(val) === b ? ' on' : '')}
                onClick={() => update(node.id, { value: b })}>{b ? 'Yes' : 'No'}</button>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="dl-x" title="Remove" onClick={() => remove(node.id)}>×</button>
    </div>
  );
}

function Group({ node, fields, depth, update, remove, addChild }) {
  const first = fields[0];
  return (
    <div className={'dl-group' + (depth > 0 ? ' nested' : '')}>
      <div className="dl-grouphead">
        <div className="dl-seg">
          {['AND', 'OR'].map((c) => (
            <button key={c} type="button" className={'dl-segbtn' + (node.combinator === c ? ' on' : '')}
              onClick={() => update(node.id, { combinator: c })}>{c}</button>
          ))}
        </div>
        <span className="dl-matchtxt">{node.combinator === 'AND' ? 'match all of' : 'match any of'}</span>
        <div className="dl-spacer" />
        <button type="button" className="dl-addbtn" onClick={() => addChild(node.id, {
          id: nid(), type: 'condition', field: first.key, op: first.ops[0], value: defaultValue(first),
        })}>+ Condition</button>
        {depth < 2 && (
          <button type="button" className="dl-addbtn ghost"
            onClick={() => addChild(node.id, { id: nid(), type: 'group', combinator: 'OR', children: [] })}>+ Group</button>
        )}
        {depth > 0 && <button type="button" className="dl-x" onClick={() => remove(node.id)}>×</button>}
      </div>
      <div className="dl-children">
        {node.children.length === 0 && <div className="dl-empty">No conditions — this group matches everyone.</div>}
        {node.children.map((c) => c.type === 'group'
          ? <Group key={c.id} node={c} fields={fields} depth={depth + 1} update={update} remove={remove} addChild={addChild} />
          : <Condition key={c.id} node={c} fields={fields} update={update} remove={remove} />)}
      </div>
    </div>
  );
}

export default function Dialer() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);      // {fields, rms} | {error}
  const [name, setName] = useState('');
  const [tree, setTree] = useState(emptyTree);
  const [rms, setRms] = useState([]);
  const [strategy, setStrategy] = useState('assigned');
  const [gap, setGap] = useState(0);
  const [win, setWin] = useState({ start: '10:00', end: '19:00' });
  const [attempts, setAttempts] = useState(1);
  const [cooldown, setCooldown] = useState(180);
  const [preview, setPreview] = useState({ count: 0, scoped: false, loading: false, error: '' });
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api.get('/api/dialer/fields')
      .then(setMeta)
      .catch((e) => setMeta({ error: e?.status === 403 ? 'admin' : (e?.data?.error || e?.message) }));
  }, []);

  const fields = meta?.fields || [];
  const pool = meta?.rms || [];

  const update = (id, patch) => setTree((t) => mapTree(t, (n) => (n.id === id ? { ...n, ...patch } : n)));
  const remove = (id) => setTree((t) => removeById(t, id));
  const addChild = (pid, child) => setTree((t) => mapTree(t, (n) =>
    n.id === pid && n.type === 'group' ? { ...n, children: [...n.children, child] } : n));

  // Live match count, debounced as the tree/pool/strategy change.
  const key = useMemo(() => JSON.stringify([tree, strategy, rms]), [tree, strategy, rms]);
  const seq = useRef(0);
  useEffect(() => {
    if (!meta || meta.error) return;
    const mine = ++seq.current;
    setPreview((p) => ({ ...p, loading: true, error: '' }));
    const t = setTimeout(() => {
      api.post('/api/dialer/preview', { rules: tree, strategy, rms }, { silent: true })
        .then((r) => { if (mine === seq.current) setPreview({ count: r.count, scoped: r.scoped, loading: false, error: '' }); })
        .catch((e) => { if (mine === seq.current) setPreview({ count: 0, scoped: false, loading: false, error: e?.data?.error || e?.message || 'bad rule' }); });
    }, 300);
    return () => clearTimeout(t);
  }, [key, meta]);

  function resetForm() {
    setName(''); setTree(emptyTree()); setRms([]); setStrategy('assigned');
    setGap(0); setWin({ start: '10:00', end: '19:00' }); setAttempts(1); setCooldown(180);
  }

  async function launch() {
    if (!name.trim()) return toast('Name the campaign first', 'error');
    if (!rms.length) return toast('Pick at least one RM to do the calling', 'error');
    if (windowHasPassed(win.start, win.end)) {
      return toast(`${win.start}–${win.end} IST already ended today — nothing would be dialled`, 'error');
    }
    setStarting(true);
    try {
      const d = await api.post('/api/dialer/campaigns', {
        name: name.trim(), rules: tree, rms, strategy,
        gap_seconds: gap, window_start: win.start, window_end: win.end,
        max_attempts: attempts, cooldown_minutes: cooldown, start: true,
      }, { silent: true });
      const dropped = d.unowned ? ` · ${d.unowned} not assigned to this pool` : '';
      toast(`Dialing ${d.queued} leads across ${rms.length} RM${rms.length > 1 ? 's' : ''}${dropped}`, d.queued ? 'success' : 'info');
      resetForm();
      navigate('/dialer/previous');
    } catch (e) {
      toast(e?.data?.error || e?.message || 'Could not start', 'error');
    } finally {
      setStarting(false);
    }
  }

  if (meta?.error) {
    return <div className="card dl-empty" style={{ padding: 28 }}>
      {meta.error === 'admin' ? "The auto dialer is admin-only — it rings other people's phones." : meta.error}
    </div>;
  }

  const matched = preview.count;
  const scoped = preview.scoped;

  return (
    <div className="dl-page">
      <div className="dl-head">
        <input className="dl-nameinput" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Name this campaign…" maxLength={120} />
        <span className="dl-matchchip">
          {preview.loading ? 'counting…' : scoped ? `${matched} leads to call` : `${matched} leads matched`}
        </span>
        <div className="dl-spacer" />
        <button className="btn-primary" onClick={launch} disabled={starting || !name.trim() || !meta}>
          {starting ? 'Starting…' : 'Start dialing'}
        </button>
      </div>

      <div className="dl-main">
        <section className="card dl-card">
          <div className="dl-cardhead">
            <div><div className="dl-eyebrow">Step 1</div><h2 className="dl-cardtitle">Who gets called</h2></div>
            <span className="dl-count"><b>{matched}</b> {scoped ? 'assigned to this pool' : 'leads'}</span>
          </div>
          {!meta ? <div className="dl-empty">Loading fields…</div>
            : <Group node={tree} fields={fields} depth={0} update={update} remove={remove} addChild={addChild} />}
          <p className="dl-note">
            Leads with no phone number are never dialled whatever the rules say.
            {preview.error && <> · <span className="dl-bad">{preview.error}</span></>}
          </p>
        </section>

        <section className="card dl-card">
          <div className="dl-cardhead">
            <div><div className="dl-eyebrow">Step 2</div><h2 className="dl-cardtitle">Who calls them</h2></div>
          </div>
          <div className="dl-strat">
            {STRATEGIES.map((s) => (
              <button key={s.key} type="button" className={'dl-stratcard' + (strategy === s.key ? ' on' : '')}
                onClick={() => setStrategy(s.key)}>
                <span className="dl-stratlabel">{s.label}</span>
                <span className="dl-strathint">{s.hint}</span>
              </button>
            ))}
          </div>
          <div className="dl-rmpool">
            {pool.map((r) => {
              const on = rms.includes(r.email);
              return (
                <button key={r.email} type="button" className={'dl-rmchip' + (on ? ' on' : '')}
                  disabled={!r.has_phone}
                  title={r.has_phone ? r.email : "No mobile number on file — can't be dialled"}
                  onClick={() => setRms(on ? rms.filter((e) => e !== r.email) : [...rms, r.email])}>
                  <span className="dl-avatar">{(r.name[0] || '?').toUpperCase()}</span>
                  <span className="dl-rmmeta">
                    <b>{r.name}</b>
                    <span>{r.has_phone ? r.email : 'no mobile on file'}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="dl-note">
            {rms.length || 'No'} RM{rms.length === 1 ? '' : 's'} selected — that's <b>{rms.length} call{rms.length === 1 ? '' : 's'} at a time</b>,
            one per handset. Their phone rings first; the lead is only dialled once they pick up.
            {strategy === 'assigned' && ' Each RM only calls their own leads, so a matched lead assigned to nobody here is dropped when the campaign starts.'}
          </p>
        </section>

        <section className="card dl-card">
          <div className="dl-cardhead">
            <div><div className="dl-eyebrow">Step 3</div><h2 className="dl-cardtitle">Pacing</h2></div>
          </div>
          <div className="dl-settings">
            <label className="dl-field"><span>Gap between calls (seconds)</span>
              <input type="number" min={0} max={3600} className="dl-input" value={gap}
                onChange={(e) => setGap(Math.max(0, Number(e.target.value)))} />
              <em className="dl-hint">0 = the next lead rings the moment the last call ends</em>
            </label>
            <label className="dl-field"><span>Calling window (IST)</span>
              <div className="dl-daterow">
                <input type="time" className="dl-input" value={win.start} onChange={(e) => setWin({ ...win, start: e.target.value })} />
                <span className="dl-dash">–</span>
                <input type="time" className="dl-input" value={win.end} onChange={(e) => setWin({ ...win, end: e.target.value })} />
              </div>
              {windowHasPassed(win.start, win.end) && (
                <em className="dl-hint" style={{ color: 'var(--red)' }}>⏰ Already ended today — this campaign would dial nobody until tomorrow.</em>
              )}
            </label>
            <label className="dl-field"><span>Max attempts / lead</span>
              <input type="number" min={1} max={10} className="dl-input" value={attempts}
                onChange={(e) => setAttempts(Math.max(1, Number(e.target.value)))} />
              <em className="dl-hint">Retries only leads that never connected</em>
            </label>
            <label className="dl-field"><span>Cooldown before a retry (minutes)</span>
              <input type="number" min={0} className="dl-input" value={cooldown} disabled={attempts < 2}
                onChange={(e) => setCooldown(Math.max(0, Number(e.target.value)))} />
            </label>
          </div>
        </section>
      </div>
    </div>
  );
}
