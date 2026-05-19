import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import {
  displayCity, formatPrice, REJECT_REASONS, STAGE_DOT_COLOR, STAGES,
  stageLabel, starColor, todayISO, variation,
} from '../utils/format.js';
import VisitScheduleModal from './VisitScheduleModal.jsx';
import RejectReasonModal from './RejectReasonModal.jsx';

/**
 * Detail popup for a single inventory row — opened by clicking a row in the
 * table. Owns its own edit state (notes, seller fields, follow-up, stage),
 * delegates the visit-schedule and reject-reason flows to their respective
 * sub-modals, and bubbles every saved change up via onUpdated so the
 * parent can patch its row list in place.
 */
export default function CardDetailModal({ item, role, onUpdated, onClose }) {
  const [notes, setNotes] = useState(item.notes || '');
  const [sellerName, setSellerName] = useState(item.seller_name || '');
  const [sellerPhone, setSellerPhone] = useState(item.seller_phone || '');
  const [followUp, setFollowUp] = useState(item.follow_up_at ? item.follow_up_at.slice(0, 10) : '');
  const [tower, setTower] = useState(item.tower || '');
  const [unitNo, setUnitNo] = useState(item.unit_no || '');
  const [savingField, setSavingField] = useState(null);
  const [savingStage, setSavingStage] = useState(false);
  const [showVisit, setShowVisit] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const colorPickerRef = useRef(null);

  const canEdit = ['admin', 'manager', 'rm'].includes(role);
  const canSetPriority = ['admin', 'manager', 'rm'].includes(role);
  const v = variation(item.price, item.oh_price);
  const isNearest = item.oh_price_match === 'nearest';
  const matchTag = isNearest ? '~' : '';
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

  async function applyStage(newStage, extraBody = {}) {
    try {
      setSavingStage(true);
      const r = await api.patch(`/api/inventory/${item.oh_id}`, { stage: newStage, ...extraBody });
      onUpdated(r.item || { ...item, stage: newStage, ...extraBody });
    } finally {
      setSavingStage(false);
    }
  }

  async function changeStage(newStage) {
    if (newStage === item.stage) return;
    if (newStage === 'visit_scheduled') {
      // If a visit already exists for this row (forms_visit_id or visit_at
      // is set), skip the schedule modal and just flip the stage — Forms
      // already knows about it, no new request needed.
      if (item.forms_visit_id || item.visit_at) {
        const when = item.visit_at ? new Date(item.visit_at).toLocaleString() : 'previously';
        if (!window.confirm(
          `Visit already scheduled for ${item.oh_id} on ${when}.\n` +
          `Reuse it and just move the stage to Visit Scheduled? (No new request will be sent.)`
        )) return;
        await applyStage('visit_scheduled');
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

  async function pickColor(picked) {
    if (!canSetPriority || savingField === 'star_color') return;
    setShowColorPicker(false);
    // Map UI choice -> persisted value + side effects.
    //   yellow -> priority on, cp_match unchanged (yellow is about priority,
    //             not match quality).
    //   green  -> cp_match='perfect' so the manual pick reflects in scan data.
    //   red    -> cp_match='partial', same idea.
    //   none   -> wipe every trigger: star_color='none' suppresses display,
    //             priority off, cp_match cleared.
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
      console.error('star_color update failed', err);
    } finally {
      setSavingField(null);
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal modal-card-detail" onClick={(e) => e.stopPropagation()}>
          <div className="card-detail-head">
            <div className="card-detail-title">
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
                    aria-haspopup="true"
                    aria-expanded={showColorPicker}
                  >★</button>
                  {showColorPicker && canSetPriority && (
                    <div className="color-picker" role="menu">
                      <button
                        type="button"
                        className={`color-picker-swatch ${color === 'yellow' ? 'color-picker-swatch-active' : ''}`}
                        onClick={() => pickColor('yellow')}
                        title="Yellow (priority)"
                        aria-label="Yellow star"
                        aria-current={color === 'yellow' ? 'true' : undefined}
                      ><span className="prio-star prio-on">★</span></button>
                      <button
                        type="button"
                        className={`color-picker-swatch ${color === 'green' ? 'color-picker-swatch-active' : ''}`}
                        onClick={() => pickColor('green')}
                        title="Perfect Match"
                        aria-label="Perfect match"
                        aria-current={color === 'green' ? 'true' : undefined}
                      ><span className="prio-star cp-perfect">★</span></button>
                      <button
                        type="button"
                        className={`color-picker-swatch ${color === 'red' ? 'color-picker-swatch-active' : ''}`}
                        onClick={() => pickColor('red')}
                        title="Partial Match"
                        aria-label="Partial match"
                        aria-current={color === 'red' ? 'true' : undefined}
                      ><span className="prio-star cp-partial">★</span></button>
                      <button
                        type="button"
                        className={`color-picker-swatch ${color === null ? 'color-picker-swatch-active' : ''}`}
                        onClick={() => pickColor('none')}
                        title="Blank"
                        aria-label="Blank star"
                        aria-current={color === null ? 'true' : undefined}
                      ><span className="prio-star prio-off">★</span></button>
                    </div>
                  )}
                </span>
              )}
              <strong>{item.society || '—'}</strong>
              <span className="city-chip">{displayCity(item.city)?.toUpperCase()}</span>
              <span className="oh-id">{item.oh_id}</span>
              <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[item.stage] }} />
            </div>
            <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>

          <div className="card-detail-sub">
            {item.locality ? <span>{item.locality}</span> : null}
            {item.floor ? <span>· {item.floor}</span> : null}
            {item.bedrooms != null && <span>· {item.bedrooms} BHK</span>}
            {item.area_sqft != null && <span>· {item.area_sqft} sqft</span>}
            <span>· <strong className="val-orange">{formatPrice(item.price)}</strong></span>
          </div>

          <div className="exp-grid">
            <div>
              <span className="exp-lbl">Listing</span>
              <a href={item.listing_link} target="_blank" rel="noreferrer" className="exp-link">{item.listing_link}</a>
            </div>
            <div><span className="exp-lbl">Posted</span><span>{item.posting_date || '—'}</span></div>
            <div>
              <span className="exp-lbl">Seller Name</span>
              <input
                className="exp-input"
                value={sellerName}
                onChange={(e) => setSellerName(e.target.value)}
                onBlur={() => saveField('seller_name', sellerName, item.seller_name)}
                disabled={!canEdit}
              />
              {savingField === 'seller_name' && <span className="exp-saving"> saving…</span>}
            </div>
            <div>
              <span className="exp-lbl">Contact No.</span>
              <input
                className="exp-input"
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
              {savingField === 'seller_phone' && <span className="exp-saving"> saving…</span>}
            </div>
            <div>
              <span className="exp-lbl">Tower</span>
              <input
                className="exp-input"
                value={tower}
                onChange={(e) => setTower(e.target.value)}
                onBlur={() => saveField('tower', tower, item.tower)}
                placeholder="e.g. T3"
                disabled={!canEdit}
              />
              {savingField === 'tower' && <span className="exp-saving"> saving…</span>}
            </div>
            <div>
              <span className="exp-lbl">Unit No.</span>
              <input
                className="exp-input"
                value={unitNo}
                onChange={(e) => setUnitNo(e.target.value)}
                onBlur={() => saveField('unit_no', unitNo, item.unit_no)}
                placeholder="e.g. 1502"
                disabled={!canEdit}
              />
              {savingField === 'unit_no' && <span className="exp-saving"> saving…</span>}
            </div>
            <div><span className="exp-lbl">Source</span><span>{item.source || '—'}</span></div>
            <div>
              <span className="exp-lbl">OH Price</span>
              <span className={item.oh_price ? (isNearest ? 'val-amber' : 'val-green') : 'muted'}>
                {item.oh_price ? `${matchTag}${formatPrice(item.oh_price)}` : 'no match'}
                {item.oh_price && item.oh_price_area
                  ? ` (${isNearest ? 'nearest' : 'matched'} ${item.oh_price_bhk}BHK, ${item.oh_price_area}sqft)`
                  : ''}
              </span>
            </div>
            <div>
              <span className="exp-lbl">Variation</span>
              <span className={v ? `val-var-${v.sign}` : 'muted'}>
                {v ? v.label : 'no match'}
              </span>
            </div>
            <div>
              <span className="exp-lbl">Follow-up date</span>
              <input
                type="date"
                className="exp-input"
                value={followUp}
                min={todayISO()}
                onChange={(e) => setFollowUp(e.target.value)}
                onBlur={() => saveField('follow_up_at', followUp, item.follow_up_at?.slice?.(0, 10))}
                disabled={!canEdit}
              />
              {savingField === 'follow_up_at' && <span className="exp-saving"> saving…</span>}
            </div>
          </div>

          {canEdit && (
            <div className="exp-actions">
              <label>Stage</label>
              <select
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

          {item.stage === 'rejected' && item.reject_reason && (
            <div className="exp-reject-line">
              <span className="exp-lbl">Reject reason</span>
              <span>{REJECT_REASONS.find((r) => r.value === item.reject_reason)?.label || item.reject_reason}</span>
            </div>
          )}

          <div className="exp-notes">
            <label>Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => saveField('notes', notes, item.notes)}
              placeholder="Add a note…"
              rows={4}
              disabled={!canEdit}
            />
            <div className="exp-notes-actions">
              {savingField === 'notes' && <div className="exp-saving">saving…</div>}
              {canEdit && (notes || '') !== (item.notes || '') && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => saveField('notes', notes, item.notes)}
                  disabled={savingField === 'notes'}
                >
                  {savingField === 'notes' ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {showVisit && (
        <VisitScheduleModal
          item={item}
          onClose={() => setShowVisit(false)}
          onScheduled={(updated) => { setShowVisit(false); onUpdated(updated); }}
        />
      )}

      {showReject && (
        <RejectReasonModal
          ohId={item.oh_id}
          onClose={() => setShowReject(false)}
          onSelect={async (reason) => {
            await applyStage('rejected', { reject_reason: reason });
            setShowReject(false);
          }}
        />
      )}
    </>
  );
}
