import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { rejectReasonLabel, stageLabel, STAGE_DOT_COLOR, SUPPLY_STAGES } from '../utils/format.js';
import InventoryBoard from '../components/InventoryBoard.jsx';
import { IconLeads, IconFollowUp, IconPipeline, IconRejected, IconQualified, IconVisit, IconLock, IconTicket } from '../components/icons.jsx';

const REJECTED_TOP = 3;

function StatTile({ num, label, accent }) {
  return (
    <div className="stat-tile">
      <div className={`st-num ${accent ? 'accent' : ''}`}>{num}</div>
      <div className="st-lbl">{label}</div>
    </div>
  );
}

function QuadCard({ color, Icon, title, to, children }) {
  return (
    <Link to={to} className="quad-card" style={{ '--qc': color }}>
      <div className="quad-head">
        <span className="qh-ic" style={{ color }}><Icon size={20} /></span>
        <h3>{title}</h3>
        <span className="qh-link">View →</span>
      </div>
      {children}
    </Link>
  );
}

// One Today's-Task card: how many of the rows that sat in this stage at the
// start of the day have since been worked (moved to a different stage). When
// `locked`, the content is dimmed and a full-opacity lock overlays it — the
// lock is a SIBLING of the dimmed content (parent opacity would otherwise cap
// the child's opacity).
function TaskCard({ color, Icon, title, total, worked, loading, locked = false, onMouseEnter, onMouseLeave, to = null }) {
  const pct = (worked != null && total > 0) ? Math.round((worked / total) * 100) : 0;
  const noTask = !loading && total === 0;
  const inner = (
    <>
      <div className="tc-content">
        <div className="tc-head">
          <span className="tc-ic" style={{ color }}><Icon size={18} /></span>
          <h4>{title}</h4>
        </div>
        {noTask ? (
          <div className="tc-notask">No Task</div>
        ) : (
          <>
            <div className="tc-frac">
              <span className="tc-worked">{loading ? '—' : (worked == null ? '—' : worked)}</span>
              <span className="tc-of">/ {loading ? '—' : total}</span>
              <span className="tc-frac-lbl">worked</span>
            </div>
            <div className="tc-bar"><div className="tc-bar-fill" style={{ width: `${pct}%` }} /></div>
            <div className="tc-sub">{loading ? '—' : `${total} created today · ${pct}% done`}</div>
          </>
        )}
      </div>
      {locked && <span className="tc-lock" aria-label="Locked"><IconLock size={26} /></span>}
    </>
  );
  const cls = `task-card ${locked ? 'task-card-locked' : ''} ${to && !locked ? 'task-card-link' : ''}`;
  // Linkable (admins → Track Tasks) only when not locked; locked cards stay plain.
  if (to && !locked) {
    return (
      <Link to={to} className={cls} style={{ '--tc': color }} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        {inner}
      </Link>
    );
  }
  return (
    <div className={cls} style={{ '--tc': color }} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {inner}
    </div>
  );
}

// Third Today's-Task slot: unresolved tickets needing this user's action. Not a
// progress card — a big count that links to the Tickets page.
function TicketTaskCard({ count, loading }) {
  const noTickets = !loading && !count;
  return (
    <Link to="/tickets" className="task-card task-card-link" style={{ '--tc': '#0ea5e9' }}>
      <div className="tc-content">
        <div className="tc-head">
          <span className="tc-ic" style={{ color: '#0ea5e9' }}><IconTicket size={18} /></span>
          <h4>UNRESOLVED TICKETS</h4>
        </div>
        {noTickets ? (
          <div className="tc-notask">No tickets</div>
        ) : (
          <>
            <div className="tc-frac">
              <span className="tc-worked">{loading ? '—' : count}</span>
              <span className="tc-frac-lbl">need your action</span>
            </div>
            <div className="tc-sub">{loading ? '—' : 'Tap to open the Tickets page'}</div>
          </>
        )}
      </div>
    </Link>
  );
}

function TodaysTask({ task, loading, role, tickets }) {
  const isAdmin = role === 'admin';
  const total1 = task?.leads?.total ?? 0;
  const worked1 = task?.leads?.worked ?? 0;
  // Task 1 is done when every new lead is worked (also vacuously when there are
  // none: 0 >= 0). Task 2 stays locked until then — except for admins, who are
  // never gated.
  const task2Locked = !loading && !isAdmin && worked1 < total1;
  // Where a clicked card goes: admins → Track Tasks (their overview), RMs → the
  // Leads board to work them. Managers have no destination → non-clickable.
  const taskTo = isAdmin ? '/track-tasks' : (role === 'rm' ? '/leads' : undefined);
  const [showToast, setShowToast] = useState(false);

  return (
    <section className="todays-task">
      <h2 className="tt-title">Today's Task</h2>
      <div className="task-grid">
        <TaskCard color="#fa541c" Icon={IconLeads} title="TASK 1 : NEW LEADS → ACTIVE LEADS"
          total={total1} worked={worked1} loading={loading}
          to={taskTo} />
        <TaskCard color="#f59e0b" Icon={IconQualified} title="TASK 2 : NEW ACTIVE LEADS → QUALIFIED LEADS"
          total={task?.active?.total ?? 0} worked={task?.active?.worked ?? 0} loading={loading}
          locked={task2Locked}
          to={taskTo}
          onMouseEnter={() => task2Locked && setShowToast(true)}
          onMouseLeave={() => setShowToast(false)} />
        <TicketTaskCard count={tickets} loading={loading} />
      </div>
      {showToast && <div className="task-toast">COMPLETE TASK 1 FIRST</div>}
    </section>
  );
}

function BoardView({ s, loading }) {
  const d = (x) => (loading ? '—' : (x ?? 0));

  // Rejected breakdown: top 3 reasons by count, the rest folded into "Others".
  const byReason = s?.rejected?.by_reason || {};
  const rejRows = Object.entries(byReason)
    .map(([value, n]) => ({ value, n, label: value === 'unspecified' ? 'Unspecified' : rejectReasonLabel(value) }))
    .sort((a, b) => b.n - a.n);
  const rejTop = rejRows.slice(0, REJECTED_TOP);
  const rejOthers = rejRows.slice(REJECTED_TOP).reduce((sum, r) => sum + r.n, 0);

  return (
    <div className="home-quad home-quad-3">
      {/* ── Row 1 ── */}
      <QuadCard color="#fa541c" Icon={IconLeads} title="Leads" to="/leads">
        <div className="quad-stats">
          <StatTile num={d(s?.leads?.lead_new)} label="Lead · New" accent />
          <StatTile num={d(s?.leads?.lead_old)} label="Lead · Old" />
          <StatTile num={d(s?.leads?.active_new)} label="Active · New" accent />
          <StatTile num={d(s?.leads?.active_old)} label="Active · Old" />
        </div>
      </QuadCard>

      <QuadCard color="#16a34a" Icon={IconQualified} title="Qualified Leads" to="/qualified-leads">
        <div className="quad-stats">
          <StatTile num={d(s?.qualified?.new)} label="New" accent />
          <StatTile num={d(s?.qualified?.old)} label="Old" />
        </div>
      </QuadCard>

      <QuadCard color="#f97316" Icon={IconFollowUp} title="Follow Up" to="/follow-ups">
        <div className="quad-stats">
          <StatTile num={d(s?.follow_up?.new)} label="New" accent />
          <StatTile num={d(s?.follow_up?.old)} label="Old" />
        </div>
      </QuadCard>

      {/* ── Row 2 ── */}
      <QuadCard color="#6366f1" Icon={IconVisit} title="Visit Scheduled" to="/visit-scheduled">
        <div className="quad-stats cols-1">
          <div>
            <div className="stat-row">
              <span className="sr-lbl"><span className="stage-dot" style={{ background: '#16a34a' }} />Visit Completed</span>
              <span className="sr-num">{d(s?.visit?.completed)}</span>
            </div>
            <div className="stat-row">
              <span className="sr-lbl"><span className="stage-dot" style={{ background: '#6366f1' }} />To be Completed</span>
              <span className="sr-num">{d(s?.visit?.to_be_completed)}</span>
            </div>
            <div className="stat-row">
              <span className="sr-lbl"><span className="stage-dot" style={{ background: '#f97316' }} />Overdue</span>
              <span className="sr-num" style={{ color: '#f97316' }}>{d(s?.visit?.overdue)}</span>
            </div>
          </div>
        </div>
      </QuadCard>

      <QuadCard color="#0ea5e9" Icon={IconPipeline} title="Supply Closure Tracker" to="/pipeline">
        <div className="quad-stats cols-1">
          <div>
            {SUPPLY_STAGES.map((st) => (
              <div key={st} className="stat-row">
                <span className="sr-lbl"><span className="stage-dot" style={{ background: STAGE_DOT_COLOR[st] }} />{stageLabel(st)}</span>
                <span className="sr-num">{d(s?.supply?.[st])}</span>
              </div>
            ))}
          </div>
        </div>
      </QuadCard>

      <QuadCard color="#ef4444" Icon={IconRejected} title="Rejected" to="/rejected">
        <div className="quad-stats cols-1">
          <div>
            <div className="stat-row">
              <span className="sr-lbl"><strong>Total Rejected</strong></span>
              <span className="sr-num">{d(s?.rejected?.total)}</span>
            </div>
            {rejTop.map((r) => (
              <div key={r.value} className="stat-row">
                <span className="sr-lbl"><span className="stage-dot" style={{ background: '#ef4444' }} />{r.label}</span>
                <span className="sr-num">{r.n}</span>
              </div>
            ))}
            {rejOthers > 0 && (
              <div className="stat-row">
                <span className="sr-lbl"><span className="stage-dot" style={{ background: '#94a3b8' }} />Others</span>
                <span className="sr-num">{rejOthers}</span>
              </div>
            )}
          </div>
        </div>
      </QuadCard>
    </div>
  );
}

export default function Home() {
  const { user } = useAuth();
  const [view, setView] = useState('board'); // board | table
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.get('/api/home/summary')
      .then((r) => { if (alive) setSummary(r); })
      .catch(() => { if (alive) setSummary(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const toggle = (
    <div className="view-toggle">
      <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>Board</button>
      <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button>
    </div>
  );

  return (
    <div>
      {/* Board/Table toggle pinned to the page's top-right, same spot in both views. */}
      <div className="home-viewbar">{toggle}</div>
      {view === 'board' ? (
        <>
          <TodaysTask task={summary?.todays_task} loading={loading} role={user?.role} tickets={summary?.unresolved_tickets} />
          <div className="page-head"><h2>Summary</h2></div>
          <BoardView s={summary} loading={loading} />
        </>
      ) : (
        <InventoryBoard showReasonCol showExport
          extraStageGroups={[{ key: 'post_visit', label: 'Post Visit', stages: SUPPLY_STAGES, color: '#6366f1', before: 'rejected' }]} />
      )}
    </div>
  );
}
