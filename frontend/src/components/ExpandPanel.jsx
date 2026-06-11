import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import NoteThread from './NoteThread.jsx';
import StatusEditModal from './StatusEditModal.jsx';
import EditDetailsModal from './EditDetailsModal.jsx';
import OhPrice from './OhPrice.jsx';
import TicketModal, { emitTicketsChanged, ticketStatusClass, ticketStatusLabel } from './TicketModal.jsx';
import { formatDateShort, formatPrice, STAGE_DOT_COLOR, stageLabel, supplyReasonLabel, variation } from '../utils/format.js';

function Field({ label, children }) {
  return (
    <div className="field-row">
      <span className="field-lbl">{label}</span>
      <span className="field-val">{children ?? '—'}</span>
    </div>
  );
}

// Assigned-RM row in Seller Details. Visible to admin + manager; admin can
// change it inline via PUT <oh_id>/assigned-rms (same endpoint Edit Details
// uses). Changing collapses to a single primary RM, mirroring Edit Details.
function AssignedRmField({ item, role, onUpdated }) {
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
        {isAdmin && <button type="button" className="btn-link" style={{ marginLeft: 8 }} onClick={startEdit}>Change</button>}
      </span>
    </div>
  );
}

// 5th column: tickets raised on this property. Lazy-loads on mount, shows the
// latest on top with a "+N more" toggle, and lets admin/manager raise a new one.
function TicketsSection({ item, role }) {
  const canCreate = role === 'admin' || role === 'manager';
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
    <div className="expand-sec">
      <h4>🎫 Tickets
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
                <span className="tk-mini-meta">{(t.messages || []).length} repl{(t.messages || []).length === 1 ? 'y' : 'ies'}</span>
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
export default function ExpandPanel({ item, role, onUpdated, canPost = true, sections, canEditStatus = true, showAssignedRm = true }) {
  const show = sections || ['property', 'pricing', 'seller', 'notes', 'tickets'];
  const v = variation(item.price, item.oh_price);
  const listing = item.listing_link && !/^internal:\/\//.test(item.listing_link) ? item.listing_link : null;
  const canEdit = canEditStatus && (['admin', 'manager', 'rm'].includes(role) || canPost);
  // Editing the raw property/seller fields is allowed wherever editing is
  // enabled, for the same roles the backend PATCH accepts.
  const canEditDetails = canEditStatus && ['admin', 'manager', 'rm'].includes(role);
  const [showStatus, setShowStatus] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  return (
    <div className="expand-inner">
      {show.includes('property') && (
        <div className="expand-sec">
          <h4>🏠 Property Details
            {canEditDetails && (
              <button type="button" className="btn-edit-details" onClick={() => setShowEdit(true)}>✎ Edit Details</button>
            )}
          </h4>
          <div className="field-grid-2">
            <Field label="Area">{item.area_sqft != null ? `${item.area_sqft} sqft` : '—'}</Field>
            <Field label="BHK">{item.bedrooms != null ? `${item.bedrooms} BHK` : '—'}</Field>
            <Field label="Tower">{item.tower || '—'}</Field>
            <Field label="Unit no.">{item.unit_no || '—'}</Field>
            <Field label="Floor">{item.floor || '—'}</Field>
            <Field label="Locality">{item.locality || '—'}</Field>
          </div>
        </div>
      )}

      {show.includes('pricing') && (
        <div className="expand-sec">
          <h4>💰 Pricing &amp; Source</h4>
          <div className="field-grid-2">
            <Field label="Asking"><span className="val-orange">{formatPrice(item.price)}</span></Field>
            <Field label="OH Price"><OhPrice item={item} /></Field>
            <Field label="Variation">
              {v ? <span className={`val-var-${v.sign}`}>{v.label}</span> : '—'}
            </Field>
            <Field label="Source">{item.source || '—'}</Field>
            <Field label="Posted">{formatDateShort(item.posting_date)}</Field>
            <Field label="Listing">
              {listing ? <a className="inv-link" href={listing} target="_blank" rel="noreferrer">Open ↗</a> : <span className="muted">—</span>}
            </Field>
          </div>
        </div>
      )}

      {show.includes('seller') && (
        <div className="expand-sec">
          <h4>👤 Seller Details</h4>
          <Field label="Seller name">{item.seller_name || '—'}</Field>
          <Field label="Phone no.">
            {item.seller_phone
              ? <a className="inv-link" href={`tel:${item.seller_phone}`}>{item.seller_phone}</a>
              : '—'}
          </Field>
          {showAssignedRm && <AssignedRmField item={item} role={role} onUpdated={onUpdated} />}
        </div>
      )}

      {show.includes('notes') && (
        <div className="expand-sec">
          <div className="expand-status-row">
            <span className="expand-status-cur">
              <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[item.stage] }} />
              {stageLabel(item.stage)}
              {item.stage === 'visit_scheduled' && item.visit_overdue && <span className="stage-overdue">Overdue</span>}
              {item.stage_reason && <span className="muted"> · {supplyReasonLabel(item.stage_reason)}</span>}
            </span>
            {canEdit && (
              <button type="button" className="btn-soft btn-edit-status" onClick={() => setShowStatus(true)}>✎ Edit Status</button>
            )}
          </div>
          <NoteThread
            ohId={item.oh_id}
            initial={item.note_thread || []}
            canPost={canPost}
            onChange={(next) => onUpdated?.({ ...item, note_thread: next })}
          />
        </div>
      )}

      {show.includes('tickets') && <TicketsSection item={item} role={role} />}

      {showStatus && (
        <StatusEditModal item={item} onUpdated={(u) => onUpdated?.(u)} onClose={() => setShowStatus(false)} />
      )}
      {showEdit && (
        <EditDetailsModal item={item} onUpdated={(u) => onUpdated?.(u)} onClose={() => setShowEdit(false)} />
      )}
    </div>
  );
}
