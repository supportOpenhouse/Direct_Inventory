import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import NoteThread from './NoteThread.jsx';
import StatusEditModal from './StatusEditModal.jsx';
import EditDetailsModal from './EditDetailsModal.jsx';
import CancelVisitModal from './CancelVisitModal.jsx';
import RescheduleVisitModal from './RescheduleVisitModal.jsx';
import VisitScheduleModal from './VisitScheduleModal.jsx';
import OhPrice from './OhPrice.jsx';
import CallActivityCard from './CallActivityCard.jsx';
import TicketModal, { emitTicketsChanged, ticketStatusClass, ticketStatusLabel } from './TicketModal.jsx';
import { formatDateShort, formatPrice, STAGE_DOT_COLOR, stageLabel, supplyReasonLabel, SUPPLY_STAGES, variation } from '../utils/format.js';
import { IconTicket, IconHome, IconMoney, IconUser, IconCalendar, IconClose, IconEdit, IconReload } from './icons.jsx';

function Field({ label, children }) {
  return (
    <div className="field-row">
      <span className="field-lbl">{label}</span>
      <span className="field-val">{children ?? '—'}</span>
    </div>
  );
}

// assigned_rm_ids log values are stored as "[Name]" / "[Name, Name]" / "[]".
// Strip the brackets for display; empty → "Unassigned".
function cleanRm(v) {
  if (v == null) return '—';
  const s = String(v).trim();
  if (s === '[]' || s === '') return 'Unassigned';
  return s.replace(/^\[|\]$/g, '');
}

// Assigned-RM row in Seller Details. Visible to admin + manager; admin can
// change it inline via PUT <oh_id>/assigned-rms (same endpoint Edit Details
// uses). Changing collapses to a single primary RM, mirroring Edit Details.
function AssignedRmField({ item, role, onUpdated, readOnly }) {
  const isAdmin = role === 'admin';
  const visible = isAdmin || role === 'manager';
  const currentRm = (item.assigned_rms && item.assigned_rms[0]) || null;
  const currentRmId = (item.assigned_rm_ids && item.assigned_rm_ids[0]) ?? (currentRm?.id ?? null);
  const names = (item.assigned_rms || []).map((r) => r.name || r.email).filter(Boolean);
  const currentLabel = names.length ? names.join(', ') : (currentRmId != null ? `#${currentRmId}` : 'Unassigned');

  const [editing, setEditing] = useState(false);
  const [rms, setRms] = useState([]);
  const [rmId, setRmId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!editing || rms.length) return undefined;
    let alive = true;
    api.get('/api/users?role=rm').then((r) => { if (alive) setRms(r.items || []); }).catch(() => {});
    return () => { alive = false; };
  }, [editing, rms.length]);

  if (!visible) return null;

  function startEdit() { setError(null); setRmId(currentRmId != null ? String(currentRmId) : ''); setEditing(true); }

  async function save() {
    setError(null);
    if (rmId === (currentRmId != null ? String(currentRmId) : '')) { setEditing(false); return; }
    try {
      setSaving(true);
      const r = await api.put(`/api/inventory/${item.oh_id}/assigned-rms`, { rm_ids: rmId ? [Number(rmId)] : [] });
      if (r?.item) onUpdated?.(r.item);
      setEditing(false);
    } catch (e) { setError(e.data?.error || e.message); } finally { setSaving(false); }
  }

  if (isAdmin && editing) {
    // Keep the current RM selectable even if it's since gone inactive.
    const rmOptions = currentRm && !rms.some((u) => u.id === currentRm.id)
      ? [{ id: currentRm.id, name: currentRm.name, email: currentRm.email }, ...rms]
      : rms;
    return (
      <div className="field-row">
        <span className="field-lbl">Assigned RM</span>
        <span className="field-val assigned-rm-edit">
          <select value={rmId} onChange={(e) => setRmId(e.target.value)} disabled={saving}>
            <option value="">— Unassigned —</option>
            {rmOptions.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
          </select>
          <button type="button" className="btn-soft" onClick={save} disabled={saving}>{saving ? '…' : 'Save'}</button>
          <button type="button" className="btn-link" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
          {error && <span className="muted">{error}</span>}
        </span>
      </div>
    );
  }

  return (
    <div className="field-row">
      <span className="field-lbl">Assigned RM</span>
      <span className="field-val">
        {currentLabel}
        {isAdmin && !item.consider_deleted && !readOnly && <button type="button" className="btn-link" style={{ display: 'block', marginTop: 2, padding: 0 }} onClick={startEdit}>Change</button>}
      </span>
    </div>
  );
}

// 5th column: tickets raised on this property. Lazy-loads on mount, shows the
// latest on top with a "+N more" toggle, and lets admin/manager raise a new one.
function TicketsSection({ item, role, readOnly }) {
  // No new tickets on an archived (soft-deleted) lead or a view-only popup (e.g. Logs).
  const canCreate = (role === 'admin' || role === 'manager') && !item.consider_deleted && !readOnly;
  const [tickets, setTickets] = useState(null); // null = loading
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get(`/api/tickets?oh_id=${encodeURIComponent(item.oh_id)}`)
      .then((r) => { if (alive) setTickets(r.items || []); })
      .catch(() => { if (alive) setTickets([]); });
    return () => { alive = false; };
  }, [item.oh_id]);

  function patch(updated) {
    setTickets((prev) => (prev || []).map((t) => (t.id === updated.id ? { ...t, ...updated } : t)));
  }

  async function create() {
    const t = title.trim();
    if (!t || busy) return;
    setError(null); setBusy(true);
    try {
      const created = await api.post('/api/tickets', { oh_id: item.oh_id, title: t, summary: summary.trim() });
      setTickets((prev) => [created, ...(prev || [])]);
      setTitle(''); setSummary(''); setCreating(false);
      emitTicketsChanged();
    } catch (e) { setError(e?.data?.error || e?.message || 'Failed to create ticket'); }
    finally { setBusy(false); }
  }

  const list = tickets || [];
  const ordered = [...list].sort((a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at));
  const shown = expanded ? ordered : ordered.slice(0, 1);
  const extra = ordered.length - shown.length;

  return (
    <div className="expand-sec sec-tickets">
      <h4><IconTicket size={14} /> Tickets
        {canCreate && !creating && (
          <button type="button" className="btn-edit-details" onClick={() => setCreating(true)}>+ New Ticket</button>
        )}
      </h4>

      {creating && (
        <div className="tk-create">
          <input className="tk-create-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" disabled={busy} />
          <textarea className="tk-create-summary" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Summary (optional)" rows={2} disabled={busy} />
          {error && <div className="note-error">{error}</div>}
          <div className="tk-create-actions">
            <button type="button" className="btn-soft" onClick={create} disabled={busy || !title.trim()}>{busy ? '…' : 'Create'}</button>
            <button type="button" className="btn-link" onClick={() => { setCreating(false); setError(null); }} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {tickets === null ? (
        <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
      ) : ordered.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>{creating ? '' : 'No tickets.'}</div>
      ) : (
        <ul className="tk-mini-list">
          {shown.map((t) => (
            <li key={t.id}>
              <button type="button" className="tk-mini" onClick={() => setOpen(t)}>
                <span className="tk-mini-top">
                  <span className="tk-mini-title">{t.title}</span>
                  <span className={`tk-badge ${ticketStatusClass(t)}`}>{ticketStatusLabel(t)}</span>
                </span>
                <span className="tk-mini-meta">{t.message_count ?? 0} repl{(t.message_count ?? 0) === 1 ? 'y' : 'ies'}</span>
              </button>
            </li>
          ))}
          {extra > 0 && <li><button type="button" className="btn-link tk-more" onClick={() => setExpanded(true)}>+{extra} more</button></li>}
          {expanded && ordered.length > 1 && <li><button type="button" className="btn-link tk-more" onClick={() => setExpanded(false)}>Show less</button></li>}
        </ul>
      )}

      {open && <TicketModal ticket={open} onChanged={patch} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * Inline drill-down panel revealed beneath a clicked table row.
 * Distributed columns: Property Details · Pricing · Seller Details · Notes · Tickets.
 * `sections` lets a host trim what's shown (Leads keeps it lean).
 */
export default function ExpandPanel({ item, role, onUpdated, canPost = true, sections, canEditStatus = true, showAssignedRm = true, viewOnly = false }) {
  const show = sections || ['property', 'pricing', 'seller', 'notes', 'rm_history', 'tickets'];
  // List rows are slim (no note_thread); fetch the full record on mount and
  // render detail sections from it. The slim parent row doubles as the
  // placeholder while it loads.
  const [detail, setDetail] = useState(null); // null = loading
  useEffect(() => {
    let alive = true;
    setDetail(null);
    api.get(`/api/inventory/${encodeURIComponent(item.oh_id)}`)
      .then((r) => { if (alive) setDetail(r); })
      .catch(() => { if (alive) setDetail({}); });
    return () => { alive = false; };
  }, [item.oh_id]);
  // Parent row wins for shared fields — it carries optimistic edits made after
  // the fetch; detail only contributes the heavy fields (note_thread, activity).
  const full = detail ? { ...detail, ...item } : item;
  // RM reassignment trail for this lead, from its activity log (oldest → newest).
  const rmHistory = (detail?.activity || [])
    .filter((a) => a.field === 'assigned_rm_ids')
    .slice()
    .reverse();
  const v = variation(full.price, full.oh_price);
  const listing = full.listing_link && !/^internal:\/\//.test(full.listing_link) ? full.listing_link : null;
  // Archived (soft-deleted) leads are read-only — nothing can be changed, only restored.
  // viewOnly forces the same button-less view without the archived styling (e.g. the Logs popup).
  const readOnly = viewOnly || !!item.consider_deleted;
  const canEdit = canEditStatus && !readOnly && (['admin', 'manager', 'rm'].includes(role) || canPost);
  // Editing the raw property/seller fields is allowed wherever editing is
  // enabled, for the same roles the backend PATCH accepts.
  const canEditDetails = canEditStatus && !readOnly && ['admin', 'manager', 'rm'].includes(role);
  const [showStatus, setShowStatus] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const [showVisitMenu, setShowVisitMenu] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  // Cancel-Visit affordance only renders for live scheduled visits and the
  // three roles that can act on them. Backend enforces the precise per-user
  // check (admin / manager-of-assigned-RM / assigned RM) and will return 403
  // if the click came from someone outside that set.
  // Independent of canEditStatus: cancel/reschedule are the intended actions on
  // a scheduled visit, so they must stay available even where general stage
  // editing is off (the Visit Status page passes allowStatusEdit=false). The
  // backend still enforces the precise per-user permission and 403s otherwise.
  const canCancelVisit = !readOnly && item.stage === 'visit_scheduled' && ['admin', 'manager', 'rm'].includes(role);
  // Revisit: schedule a fresh visit for a cancelled one. Backend lets the
  // schedule bypass the "already scheduled" guard for visit_cancelled rows.
  const canScheduleRevisit = !readOnly && item.stage === 'visit_cancelled' && ['admin', 'manager', 'rm'].includes(role);
  // No stage/status editing from visit_scheduled onward: in visit_scheduled the
  // only action is Cancel Visit, and post-visit (supply-tracker) stages are
  // driven by the CP sync — manual stage edits there would just be overwritten.
  const canEditStage = canEdit && item.stage !== 'visit_scheduled' && !SUPPLY_STAGES.includes(item.stage);

  return (
    <div className={'expand-inner' + (item.consider_deleted ? ' expand-archived' : '')}>
      {show.includes('property') && (
        <div className="expand-sec expand-sec-wide sec-property">
          <h4><IconHome size={14} /> Property Details
            {canEditDetails && (
              <button type="button" className="btn-edit-details" onClick={() => setShowEdit(true)}><IconEdit size={13} /> Edit</button>
            )}
          </h4>
          <div className="field-grid-2">
            <Field label="Area">{full.area_sqft != null ? `${full.area_sqft} sqft` : '—'}</Field>
            <Field label="BHK">{full.bedrooms != null ? `${full.bedrooms} BHK` : '—'}</Field>
            <Field label="Tower">{full.tower || '—'}</Field>
            <Field label="Unit no.">{full.unit_no || '—'}</Field>
            <Field label="Floor">{full.floor || '—'}</Field>
            <Field label="Locality">{full.locality || '—'}</Field>
          </div>
        </div>
      )}

      {show.includes('pricing') && (
        <div className="expand-sec sec-pricing">
          <h4><IconMoney size={14} /> Pricing &amp; Source</h4>
          <div className="field-grid-2">
            <Field label="Asking"><span className="val-orange">{formatPrice(full.price)}</span></Field>
            <Field label="OH Price"><OhPrice item={full} /></Field>
            <Field label="Variation">
              {v ? <span className={`val-var-${v.sign}`}>{v.label}</span> : '—'}
            </Field>
            <Field label="Source">{full.source || '—'}</Field>
            <Field label="Posted">{formatDateShort(full.posting_date)}</Field>
            <Field label="Listing">
              {listing ? <a className="inv-link" href={listing} target="_blank" rel="noreferrer">Open ↗</a> : <span className="muted">—</span>}
            </Field>
          </div>
        </div>
      )}

      {show.includes('seller') && (
        <div className="expand-sec expand-sec-narrow sec-seller">
          <h4><IconUser size={14} /> Seller Details</h4>
          <Field label="Seller name">{full.seller_name || '—'}</Field>
          <Field label="Phone no.">
            {full.seller_phone
              ? <a className="inv-link" href={`tel:${full.seller_phone}`}>{full.seller_phone}</a>
              : '—'}
          </Field>
          {showAssignedRm && <AssignedRmField item={full} role={role} onUpdated={onUpdated} readOnly={readOnly} />}
        </div>
      )}

      {/* Bonvoice call history — self-hides until this lead has been rung. */}
      <CallActivityCard ohId={item.oh_id} />

      {show.includes('notes') && (
        <div className="expand-sec sec-notes">
          <div className="expand-status-row">
            <span className="expand-status-cur">
              <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[item.stage] }} />
              <span className="expand-status-name">{stageLabel(item.stage)}</span>
              {item.stage === 'visit_scheduled' && item.visit_overdue && <span className="stage-overdue">Overdue</span>}
              {item.stage_reason && item.stage !== 'visit_cancelled' && <span className="muted"> · {supplyReasonLabel(item.stage_reason)}</span>}
            </span>
            {canScheduleRevisit && (
              <button type="button" className="btn-soft btn-edit-status" onClick={() => setShowSchedule(true)}><IconCalendar size={13} /> Schedule Revisit</button>
            )}
            {canCancelVisit && (
              <span className="visit-change-wrap">
                <button type="button" className="btn-soft btn-edit-status" onClick={() => setShowVisitMenu((v) => !v)}>Change Visit ▾</button>
                {showVisitMenu && (
                  <div className="reject-menu visit-change-menu" onMouseLeave={() => setShowVisitMenu(false)}>
                    <button type="button" onClick={() => { setShowVisitMenu(false); setShowReschedule(true); }}>Reassign / Reschedule</button>
                    <button type="button" onClick={() => { setShowVisitMenu(false); setShowCancel(true); }}><IconClose size={13} /> Cancel</button>
                  </div>
                )}
              </span>
            )}
            {canEditStage && (
              <button type="button" className="btn-soft btn-edit-status" onClick={() => setShowStatus(true)}><IconEdit size={13} /> Edit</button>
            )}
          </div>
          {detail === null ? (
            <div className="muted" style={{ fontSize: 13 }}>Loading notes…</div>
          ) : (
            <NoteThread
              ohId={item.oh_id}
              initial={full.note_thread || []}
              canPost={canPost && !readOnly}
              onChange={(next) => {
                setDetail((d) => ({ ...(d || {}), note_thread: next }));
                onUpdated?.({ ...item, note_count: next.length });
              }}
            />
          )}
        </div>
      )}

      {show.includes('rm_history') && (
        <div className="expand-sec expand-sec-narrow sec-rm">
          <h4><IconReload size={14} /> RM History</h4>
          {detail === null ? (
            <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
          ) : rmHistory.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>No reassignments.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rmHistory.map((h) => (
                <div key={h.id} style={{ fontSize: 13, lineHeight: 1.35 }}>
                  <div>{cleanRm(h.before_value)} → <strong>{cleanRm(h.after_value)}</strong></div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {(h.actor_email || '').split('@')[0] || '—'} · {formatDateShort(h.created_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {show.includes('tickets') && <TicketsSection item={item} role={role} readOnly={readOnly} />}

      {showStatus && (
        <StatusEditModal item={item} onUpdated={(u) => onUpdated?.(u)} onClose={() => setShowStatus(false)} />
      )}
      {showEdit && (
        <EditDetailsModal item={item} onUpdated={(u) => onUpdated?.(u)} onClose={() => setShowEdit(false)} />
      )}
      {showCancel && (
        <CancelVisitModal
          item={item}
          onCancelled={(u) => onUpdated?.(u)}
          onClose={() => setShowCancel(false)}
        />
      )}
      {showReschedule && (
        <RescheduleVisitModal
          item={item}
          onRescheduled={(u) => onUpdated?.(u)}
          onClose={() => setShowReschedule(false)}
        />
      )}
      {showSchedule && (
        <VisitScheduleModal
          item={item}
          onClose={() => setShowSchedule(false)}
          onScheduled={(u) => { setShowSchedule(false); onUpdated?.(u && u.oh_id ? u : { ...item, stage: 'visit_scheduled' }); }}
        />
      )}
    </div>
  );
}
