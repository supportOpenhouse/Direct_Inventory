import { useState } from 'react';
import { api } from '../api/client.js';
import { displayCity, formatPrice, formatDateRel, isManualSource, REJECT_REASONS, STAGE_DOT_COLOR, STAGES, stageLabel, todayISO, variation } from '../utils/format.js';
import VisitScheduleModal from './VisitScheduleModal.jsx';
import RejectReasonModal from './RejectReasonModal.jsx';

export default function InventoryCard({
  item, onUpdated, role,
  selectMode = false, selected = false, onToggleSelect,
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(item.notes || '');
  const [sellerName, setSellerName] = useState(item.seller_name || '');
  const [sellerPhone, setSellerPhone] = useState(item.seller_phone || '');
  const [followUp, setFollowUp] = useState(item.follow_up_at ? item.follow_up_at.slice(0, 10) : '');
  const [savingField, setSavingField] = useState(null);
  const [savingStage, setSavingStage] = useState(false);
  const [showVisit, setShowVisit] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const canEdit = ['admin', 'manager', 'rm'].includes(role);
  const canSetPriority = ['admin', 'manager'].includes(role);
  const v = variation(item.price, item.oh_price);
  const isNearest = item.oh_price_match === 'nearest';
  const matchTag = isNearest ? '~' : '';
  const isPriority = !!item.priority;

  async function togglePriority(e) {
    e?.stopPropagation();
    if (!canSetPriority || savingField === 'priority') return;
    const next = !isPriority;
    // Optimistic flip — the API call is slow on Render free tier (often
    // several seconds), and there's no reason the user should wait to see
    // the star change. We revert if the server rejects it.
    onUpdated({ ...item, priority: next });
    setSavingField('priority');
    try {
      const r = await api.patch(`/api/inventory/${item.oh_id}`, { priority: next });
      if (r?.item) onUpdated(r.item);
    } catch (err) {
      onUpdated({ ...item, priority: !next });
      console.error('priority toggle failed', err);
    } finally {
      setSavingField(null);
    }
  }

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
    if (newStage === 'visit_scheduled') { setShowVisit(true); return; }
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

  function cardClicked() {
    if (selectMode) {
      onToggleSelect?.();
    } else {
      setOpen(true);
    }
  }

  return (
    <>
      <div
        className={[
          'card',
          isManualSource(item.source) ? 'card-manual' : '',
          isPriority ? 'card-priority' : '',
          selectMode ? 'card-selectable' : '',
          selected ? 'card-selected' : '',
        ].filter(Boolean).join(' ')}
        onClick={cardClicked}
      >
        {selectMode && (
          <div className="card-checkbox" onClick={(e) => { e.stopPropagation(); onToggleSelect?.(); }}>
            <input type="checkbox" readOnly checked={selected} />
          </div>
        )}
        <div className="card-head">
          <div className="card-society">
            {(isPriority || canSetPriority) && (
              <button
                type="button"
                className={`prio-star ${isPriority ? 'prio-on' : 'prio-off'}`}
                onClick={togglePriority}
                disabled={!canSetPriority || savingField === 'priority'}
                title={canSetPriority
                  ? (isPriority ? 'Unmark Priority' : 'Mark Priority')
                  : 'Priority'}
                aria-label={isPriority ? 'Priority lead' : 'Mark as Priority'}
              >★</button>
            )}
            {item.society || '—'}
          </div>
          <div className="card-meta">
            <span className="city-chip">{displayCity(item.city)?.toUpperCase()}</span>
            <span className="oh-id">{item.oh_id}</span>
            <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[item.stage] }} />
          </div>
        </div>
        <div className="card-sub">
          {item.locality ? <span>{item.locality}</span> : null}
          {item.floor ? <span>· F{item.floor}</span> : null}
        </div>
        <div className="card-tags">
          {item.bedrooms != null && <span className="tag tag-bhk">{item.bedrooms} BHK</span>}
          {item.area_sqft != null && <span className="tag tag-area">{item.area_sqft} sqft</span>}
        </div>
        <div className="card-prices">
          <div><div className="lbl">ASKING</div><div className="val val-orange">{formatPrice(item.price)}</div></div>
          <div>
            <div className="lbl">OH PRICE</div>
            <div
              className={item.oh_price ? (isNearest ? 'val val-amber' : 'val val-green') : 'val val-muted'}
              title={isNearest && item.oh_price_area ? `Nearest match: ${item.oh_price_bhk}BHK, ${item.oh_price_area}sqft` : ''}
            >
              {item.oh_price ? `${matchTag}${formatPrice(item.oh_price)}` : '—'}
            </div>
          </div>
          <div>
            <div className="lbl">VARIATION</div>
            <div className={v ? `val val-var-${v.sign}` : 'val val-muted'}>
              {v ? v.label : '—'}
            </div>
          </div>
        </div>
        <div className="card-foot">
          <span>{formatDateRel(item.created_at)}</span>
          <span>·</span>
          <span>{item.seller_name || '—'}</span>
          {item.source && <><span>·</span><span className="src">{item.source}</span></>}
          {item.follow_up_at && (
            <><span>·</span><span className="follow-up-chip" title="Follow up">⏰ {item.follow_up_at.slice(0, 10)}</span></>
          )}
        </div>
        {item.stage === 'rejected' && item.reject_reason && (
          <div className="reject-reason">{REJECT_REASONS.find((r) => r.value === item.reject_reason)?.label || item.reject_reason}</div>
        )}
      </div>

      {open && !selectMode && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal modal-card-detail" onClick={(e) => e.stopPropagation()}>
            <div className="card-detail-head">
              <div className="card-detail-title">
                {(isPriority || canSetPriority) && (
                  <button
                    type="button"
                    className={`prio-star prio-star-lg ${isPriority ? 'prio-on' : 'prio-off'}`}
                    onClick={togglePriority}
                    disabled={!canSetPriority || savingField === 'priority'}
                    title={canSetPriority
                      ? (isPriority ? 'Unmark Priority' : 'Mark Priority')
                      : 'Priority'}
                    aria-label={isPriority ? 'Priority lead' : 'Mark as Priority'}
                  >★</button>
                )}
                <strong>{item.society || '—'}</strong>
                <span className="city-chip">{displayCity(item.city)?.toUpperCase()}</span>
                <span className="oh-id">{item.oh_id}</span>
                <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[item.stage] }} />
              </div>
              <button className="modal-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="card-detail-sub">
              {item.locality ? <span>{item.locality}</span> : null}
              {item.floor ? <span>· F{item.floor}</span> : null}
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
              {savingField === 'notes' && <div className="exp-saving">saving…</div>}
            </div>
          </div>
        </div>
      )}

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
