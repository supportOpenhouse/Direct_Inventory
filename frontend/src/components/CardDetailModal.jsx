import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import {
  displayCity, formatPrice, ohMatchInfo, REJECT_REASONS, STAGE_DOT_COLOR, STAGES,
  stageLabel, starColor, todayISO, variation,
} from '../utils/format.js';
import VisitScheduleModal from './VisitScheduleModal.jsx';
import RejectReasonModal from './RejectReasonModal.jsx';
import AssignRmModal from './AssignRmModal.jsx';
import ScheduleToast, { collectMissingLeadFields, labelFor } from './ScheduleToast.jsx';

/**
 * Detail popup for a single inventory row — opened by clicking a row in the
 * table. Owns its own edit state, delegates the visit-schedule / reject-reason
 * flows to their sub-modals, and bubbles every saved change up via onUpdated.
 *
 * Notes live on the new `note_thread` JSONB column (multi-author, timestamped)
 * — the old single-text `notes` column is no longer read or written here.
 */

// "SR" / "PK" / etc. — first letters of the first two name tokens, else first
// two characters of the name/email local-part.
function initialsOf(name, email) {
  const s = (name || (email || '').split('@')[0] || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

// Deterministic hue per identity so an author keeps the same avatar tint
// across notes / reloads.
function avatarHue(key) {
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
function avatarStyle(key) {
  const h = avatarHue(key);
  return { background: `hsl(${h}, 65%, 88%)`, color: `hsl(${h}, 55%, 28%)` };
}

function fmtNoteTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function fmtPostedDate(d) {
  if (!d) return null;
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  return x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Avatar({ name, email, sizeClass = '' }) {
  return (
    <span className={`note-av ${sizeClass}`.trim()} style={avatarStyle(email || name)}>
      {initialsOf(name, email)}
    </span>
  );
}

function NoteThread({ ohId, initial = [], canPost, currentUser, onChange }) {
  const [notes, setNotes] = useState(() => (Array.isArray(initial) ? [...initial] : []));
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState(null);

  const ordered = [...notes].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  async function send() {
    const text = draft.trim();
    if (!text || posting) return;
    setError(null);
    setPosting(true);
    try {
      const r = await api.post(`/api/inventory/${ohId}/notes`, { body: text });
      const next = r.note_thread || [...notes, r.note];
      setNotes(next);
      setDraft('');
      onChange?.(next);
    } catch (e) {
      setError(e?.data?.error || e?.message || 'Failed to post note');
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="note-thread">
      <div className="note-thread-head">
        <span className="note-thread-ic" aria-hidden>💬</span>
        <strong>Notes thread</strong>
        <span className="note-thread-count">{ordered.length}</span>
      </div>
      <ul className="note-list">
        {ordered.length === 0 && !canPost && (
          <li className="note-empty muted">No notes yet.</li>
        )}
        {ordered.map((n) => (
          <li key={n.id} className="note-item">
            <Avatar name={n.author_name} email={n.author_email} />
            <div className="note-body">
              <div className="note-meta">
                <strong>{n.author_name || n.author_email}</strong>
                <span className="note-time">{fmtNoteTime(n.created_at)}</span>
              </div>
              <div className="note-text">{n.body}</div>
            </div>
          </li>
        ))}
        {canPost && (
          <li className="note-item note-item-input">
            <Avatar name={currentUser?.name} email={currentUser?.email} />
            <div className="note-body">
              <div className="note-input-row">
                <input
                  className="note-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                  }}
                  placeholder="Add a note…"
                  disabled={posting}
                />
                <button
                  type="button"
                  className="note-send"
                  onClick={send}
                  disabled={posting || !draft.trim()}
                  aria-label="Send"
                  title="Send"
                >➤</button>
              </div>
              {error && <div className="note-error">{error}</div>}
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}

export default function CardDetailModal({ item, role, onUpdated, onClose }) {
  const { user } = useAuth();
  const [sellerName, setSellerName] = useState(item.seller_name || '');
  const [sellerPhone, setSellerPhone] = useState(item.seller_phone || '');
  const [followUp, setFollowUp] = useState(item.follow_up_at ? item.follow_up_at.slice(0, 10) : '');
  const [tower, setTower] = useState(item.tower || '');
  const [unitNo, setUnitNo] = useState(item.unit_no || '');
  const [areaSqft, setAreaSqft] = useState(item.area_sqft != null ? String(item.area_sqft) : '');
  const [bedrooms, setBedrooms] = useState(item.bedrooms != null ? String(item.bedrooms) : '');
  const [savingField, setSavingField] = useState(null);
  const [savingStage, setSavingStage] = useState(false);
  const [showVisit, setShowVisit] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const colorPickerRef = useRef(null);
  const [showAssignRm, setShowAssignRm] = useState(false);
  const [toast, setToast] = useState(null);

  const canEdit = ['admin', 'manager', 'rm'].includes(role);
  const canSetPriority = ['admin', 'manager', 'rm'].includes(role);
  const canSeeAssigned = ['admin', 'manager'].includes(role);
  // Only admin can change the per-property RM assignment.
  const canReassignRm = role === 'admin';

  // Assigned RMs come joined onto the inventory row (assigned_rms — a JSON
  // array of {id, name, email}), so chips render synchronously, no fetch.
  const assignedRms = Array.isArray(item.assigned_rms) ? item.assigned_rms : [];
  const assignedRmIds = Array.isArray(item.assigned_rm_ids) ? item.assigned_rm_ids : [];
  const v = variation(item.price, item.oh_price);
  const ohInfo = ohMatchInfo(item);
  const color = starColor(item);

  useEffect(() => {
    if (!showColorPicker) return undefined;
    function onDocClick(e) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target)) {
        setShowColorPicker(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showColorPicker]);

  // Esc closes the modal. Skip when a sub-modal (visit / reject / assign-rm)
  // is open so its own close takes precedence.
  useEffect(() => {
    if (showVisit || showReject || showAssignRm) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, showVisit, showReject, showAssignRm]);

  async function applyStage(newStage, extra = {}) {
    try {
      setSavingStage(true);
      const r = await api.patch(`/api/inventory/${item.oh_id}`, { stage: newStage, ...extra });
      onUpdated(r.item || { ...item, stage: newStage, ...extra });
    } finally {
      setSavingStage(false);
    }
  }

  async function changeStage(newStage) {
    if (newStage === item.stage) return;
    if (newStage === 'visit_scheduled') {
      if (item.forms_visit_id || item.visit_at) {
        const when = item.visit_at ? new Date(item.visit_at).toLocaleString() : 'previously';
        if (!window.confirm(
          `Visit already scheduled for ${item.oh_id} on ${when}.\n`
          + 'Reuse it and just move the stage to Visit Scheduled? (No new request will be sent.)',
        )) return;
        await applyStage('visit_scheduled');
        return;
      }
      // Pre-flight: confirm the lead has everything Forms requires before we
      // even open the visit modal. Avoids the "filled it all out, then told a
      // field is missing" pain.
      const missing = collectMissingLeadFields(item);
      if (missing.length) {
        setToast({
          kind: 'error',
          title: "Can't schedule visit — fill these in first",
          message: 'These fields are needed before the visit can be scheduled:',
          lines: missing.map(labelFor),
        });
        return;
      }
      // OpenHouse only takes 2BHK / 3BHK leads through Direct visits. Block
      // here so the visit modal isn't even reachable for other configurations.
      const bhk = Number(item.bedrooms);
      if (bhk !== 2 && bhk !== 3) {
        setToast({
          kind: 'error',
          title: 'Invalid BHK entry (Should be 2 or 3 BHK)',
        });
        return;
      }
      setShowVisit(true);
      return;
    }
    if (newStage === 'rejected') { setShowReject(true); return; }
    await applyStage(newStage);
  }

  async function saveField(field, value, originalValue) {
    if ((value || '') === (originalValue || '')) return;
    try {
      setSavingField(field);
      const body = { [field]: value || null };
      const r = await api.patch(`/api/inventory/${item.oh_id}`, body);
      onUpdated(r.item || { ...item, [field]: value });
    } finally {
      setSavingField(null);
    }
  }

  // Numeric fields — trim and coerce so a blank input clears the column and
  // digits become integers. Reject non-positive values.
  async function saveNumeric(field, raw, originalValue) {
    const trimmed = (raw || '').trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (trimmed !== '' && (!Number.isFinite(next) || next <= 0)) return;
    if ((next ?? null) === (originalValue ?? null)) return;
    try {
      setSavingField(field);
      const r = await api.patch(`/api/inventory/${item.oh_id}`, { [field]: next });
      onUpdated(r.item || { ...item, [field]: next });
    } finally {
      setSavingField(null);
    }
  }

  async function pickColor(picked) {
    if (!canSetPriority || savingField === 'star_color') return;
    setShowColorPicker(false);
    const body = { star_color: picked, priority: picked === 'yellow' };
    if (picked === 'green') body.cp_match = 'perfect';
    else if (picked === 'red') body.cp_match = 'partial';
    else if (picked === 'none') body.cp_match = null;
    const optimistic = { ...item, ...body };
    onUpdated(optimistic);
    setSavingField('star_color');
    try {
      const r = await api.patch(`/api/inventory/${item.oh_id}`, body);
      if (r?.item) onUpdated(r.item);
    } catch (err) {
      onUpdated(item);
      // eslint-disable-next-line no-console
      console.error('star_color update failed', err);
    } finally {
      setSavingField(null);
    }
  }

  const listingHref = item.listing_link && !/^internal:\/\//.test(item.listing_link)
    ? item.listing_link : null;
  const listingLabel = listingHref ? listingHref.replace(/^https?:\/\//, '') : null;
  const postedLabel = fmtPostedDate(item.posting_date || item.created_at);

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal modal-card-detail" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="cd-head">
            <div className="cd-title-row">
              {(color || canSetPriority) && (
                <span className="prio-star-wrap" ref={colorPickerRef}>
                  <button
                    type="button"
                    className={`prio-star prio-star-lg ${
                      color === 'yellow' ? 'prio-on'
                        : color === 'green' ? 'cp-perfect'
                          : color === 'red' ? 'cp-partial'
                            : 'prio-off'
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!canSetPriority || savingField === 'star_color') return;
                      setShowColorPicker((s) => !s);
                    }}
                    disabled={!canSetPriority || savingField === 'star_color'}
                    title={canSetPriority ? 'Pick star color' : 'Priority'}
                    aria-label="Pick star color"
                  >★</button>
                  {showColorPicker && canSetPriority && (
                    <div className="color-picker" role="menu">
                      <button type="button" className={`color-picker-swatch ${color === 'yellow' ? 'color-picker-swatch-active' : ''}`} onClick={() => pickColor('yellow')} title="Yellow (priority)" aria-label="Yellow"><span className="prio-star prio-on">★</span></button>
                      <button type="button" className={`color-picker-swatch ${color === 'green' ? 'color-picker-swatch-active' : ''}`} onClick={() => pickColor('green')} title="Perfect match" aria-label="Perfect"><span className="prio-star cp-perfect">★</span></button>
                      <button type="button" className={`color-picker-swatch ${color === 'red' ? 'color-picker-swatch-active' : ''}`} onClick={() => pickColor('red')} title="Partial match" aria-label="Partial"><span className="prio-star cp-partial">★</span></button>
                      <button type="button" className={`color-picker-swatch ${color === null ? 'color-picker-swatch-active' : ''}`} onClick={() => pickColor('none')} title="Blank" aria-label="Blank"><span className="prio-star prio-off">★</span></button>
                    </div>
                  )}
                </span>
              )}
              <h3 className="cd-title">{item.society || '—'}</h3>
              <span className="city-chip">{displayCity(item.city)?.toUpperCase()}</span>
              <span className="cd-spacer" />
              <span className="oh-id">{item.oh_id}</span>
              <span className="stage-dot stage-dot-lg" style={{ background: STAGE_DOT_COLOR[item.stage] }} title={stageLabel(item.stage)} />
              <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
            </div>
            <div className="cd-sub">
              {item.locality ? <span>{item.locality}</span> : null}
              {item.floor ? <span> · {item.floor}</span> : null}
              {item.bedrooms != null && <span> · {item.bedrooms} BHK</span>}
              {item.area_sqft != null && <span> · {item.area_sqft} sqft</span>}
              <span> · <strong className="val-orange">{formatPrice(item.price)}</strong></span>
            </div>
          </div>

          {/* Listing / Posted / Seller / Contact / Tower / Unit */}
          <div className="cd-section">
            <div className="cd-grid">
              <div>
                <span className="cd-lbl">Listing</span>
                {listingHref
                  ? <a href={listingHref} target="_blank" rel="noreferrer" className="cd-link">{listingLabel}</a>
                  : <span className="muted">—</span>}
              </div>
              <div>
                <span className="cd-lbl">Posted</span>
                <span>{postedLabel || '—'}</span>
              </div>

              <div>
                <span className="cd-lbl">Seller name</span>
                <input
                  className="cd-input"
                  value={sellerName}
                  onChange={(e) => setSellerName(e.target.value)}
                  onBlur={() => saveField('seller_name', sellerName, item.seller_name)}
                  disabled={!canEdit}
                />
                {savingField === 'seller_name' && <span className="cd-saving"> saving…</span>}
              </div>
              <div>
                <span className="cd-lbl">Contact no.</span>
                <input
                  className="cd-input"
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]{10}"
                  maxLength={10}
                  value={sellerPhone}
                  onChange={(e) => setSellerPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  onBlur={() => saveField('seller_phone', sellerPhone, item.seller_phone)}
                  placeholder="10-digit phone"
                  disabled={!canEdit}
                />
                {savingField === 'seller_phone' && <span className="cd-saving"> saving…</span>}
              </div>

              <div>
                <span className="cd-lbl">Area &amp; BHK</span>
                <div className="cd-tower-unit">
                  <input
                    className="cd-input cd-input-sm"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    value={areaSqft}
                    onChange={(e) => setAreaSqft(e.target.value)}
                    onBlur={() => saveNumeric('area_sqft', areaSqft, item.area_sqft)}
                    placeholder="Area sqft"
                    disabled={!canEdit}
                  />
                  <select
                    className="cd-input cd-input-sm"
                    value={bedrooms}
                    onChange={(e) => {
                      const next = e.target.value;
                      setBedrooms(next);
                      saveNumeric('bedrooms', next, item.bedrooms);
                    }}
                    disabled={!canEdit}
                  >
                    <option value="">BHK…</option>
                    {bedrooms !== '' && bedrooms !== '2' && bedrooms !== '3' && (
                      <option value={bedrooms}>{bedrooms}BHK</option>
                    )}
                    <option value="2">2BHK</option>
                    <option value="3">3BHK</option>
                  </select>
                </div>
                {(savingField === 'area_sqft' || savingField === 'bedrooms') && <span className="cd-saving"> saving…</span>}
              </div>
              <div>
                <span className="cd-lbl">Tower &amp; Unit</span>
                <div className="cd-tower-unit">
                  <input
                    className="cd-input cd-input-sm"
                    value={tower}
                    onChange={(e) => setTower(e.target.value)}
                    onBlur={() => saveField('tower', tower, item.tower)}
                    placeholder="Tower"
                    disabled={!canEdit}
                  />
                  <input
                    className="cd-input cd-input-sm"
                    value={unitNo}
                    onChange={(e) => setUnitNo(e.target.value)}
                    onBlur={() => saveField('unit_no', unitNo, item.unit_no)}
                    placeholder="Unit"
                    disabled={!canEdit}
                  />
                </div>
                {(savingField === 'tower' || savingField === 'unit_no') && <span className="cd-saving"> saving…</span>}
              </div>
            </div>
          </div>

          {/* Source / OH price / Variation / Follow-up */}
          <div className="cd-section">
            <div className="cd-grid">
              <div>
                <span className="cd-lbl">Source</span>
                <span>{item.source || '—'}</span>
              </div>
              <div>
                <span className="cd-lbl">OH price</span>
                <span className={item.oh_price ? 'val-green' : 'val-check'} title={ohInfo.title}>
                  {item.oh_price ? formatPrice(item.oh_price) : 'Check Price'}
                </span>
                {item.oh_price
                  ? item.oh_price_area && (
                      <div className="cd-sub-line">
                        matched {item.oh_price_bhk}BHK, {item.oh_price_area}sqft
                      </div>
                    )
                  : ohInfo.sub && <div className="cd-sub-line">{ohInfo.sub}</div>}
              </div>

              <div>
                <span className="cd-lbl">Variation</span>
                {v
                  ? <span className={`cd-var-pill cd-var-${v.sign}`}>{v.label}</span>
                  : <span className="muted">no match</span>}
              </div>
              <div>
                <span className="cd-lbl">Follow-up date</span>
                <input
                  type="date"
                  className="cd-input"
                  value={followUp}
                  min={todayISO()}
                  onChange={(e) => setFollowUp(e.target.value)}
                  onBlur={() => saveField('follow_up_at', followUp, item.follow_up_at?.slice?.(0, 10))}
                  disabled={!canEdit}
                />
                {savingField === 'follow_up_at' && <span className="cd-saving"> saving…</span>}
              </div>
            </div>
          </div>

          {/* Assigned RM + Stage */}
          <div className="cd-row-actions">
            {canSeeAssigned && (
              <div className="cd-row-actions-cell">
                <span className="cd-lbl">Assigned RM</span>
                <button
                  type="button"
                  className={`cd-rm-chips ${canReassignRm ? 'cd-rm-chips-edit' : ''}`}
                  onClick={canReassignRm ? () => setShowAssignRm(true) : undefined}
                  disabled={!canReassignRm}
                  title={canReassignRm ? 'Click to reassign RM(s)' : undefined}
                >
                  {assignedRms.length === 0 ? (
                    <span className="muted">Unassigned</span>
                  ) : (
                    assignedRms.map((rm) => (
                      <span key={rm.id} className="cd-rm-chip">
                        <Avatar name={rm.name} email={rm.email} sizeClass="note-av-sm" />
                        {rm.name || rm.email}
                      </span>
                    ))
                  )}
                  {canReassignRm && <span className="cd-rm-chips-edit-ic" aria-hidden>✎</span>}
                </button>
              </div>
            )}
            {canEdit && (
              <div className="cd-row-actions-cell">
                <span className="cd-lbl">Stage</span>
                <select
                  className="cd-stage-select"
                  value={item.stage}
                  onChange={(e) => changeStage(e.target.value)}
                  disabled={savingStage}
                >
                  {STAGES.map((s) => (
                    <option key={s} value={s}>{stageLabel(s)}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {item.stage === 'rejected' && item.stage_reason && (
            <div className="cd-reject-line">
              <span className="cd-lbl">Reject reason</span>
              <span>{REJECT_REASONS.find((r) => r.value === item.stage_reason)?.label || item.stage_reason}</span>
            </div>
          )}

          <NoteThread
            ohId={item.oh_id}
            initial={item.note_thread || []}
            canPost={canEdit}
            currentUser={user}
            onChange={(next) => onUpdated({ ...item, note_thread: next })}
          />
        </div>
      </div>

      {showVisit && (
        <VisitScheduleModal
          item={item}
          onClose={() => setShowVisit(false)}
          onScheduled={(updated) => { setShowVisit(false); onUpdated(updated); }}
          onToast={setToast}
        />
      )}

      <ScheduleToast toast={toast} onClose={() => setToast(null)} />

      {showReject && (
        <RejectReasonModal
          ohId={item.oh_id}
          onClose={() => setShowReject(false)}
          onSelect={async (reason) => {
            await applyStage('rejected', { stage_reason: reason });
            setShowReject(false);
          }}
        />
      )}

      {showAssignRm && (
        <AssignRmModal
          ohId={item.oh_id}
          initialRmIds={assignedRmIds}
          onClose={() => setShowAssignRm(false)}
          onSaved={(updated) => {
            setShowAssignRm(false);
            onUpdated(updated || { ...item });
          }}
        />
      )}
    </>
  );
}
