import { useState } from 'react';
import { api } from '../api/client.js';
import { displayCity, formatPrice, formatDateRel, isManualSource, REJECT_REASONS, STAGE_DOT_COLOR, STAGES, stageLabel, variation } from '../utils/format.js';
import VisitScheduleModal from './VisitScheduleModal.jsx';
import RejectReasonModal from './RejectReasonModal.jsx';

export default function InventoryCard({ item, onUpdated, role }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(item.notes || '');
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingStage, setSavingStage] = useState(false);
  const [showVisit, setShowVisit] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const canEdit = ['admin', 'manager', 'rm'].includes(role);
  const v = variation(item.price, item.oh_price);
  const isNearest = item.oh_price_match === 'nearest';
  const matchTag = isNearest ? '~' : '';

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
      setShowVisit(true);
      return;
    }
    if (newStage === 'rejected') {
      setShowReject(true);
      return;
    }
    await applyStage(newStage);
  }

  async function saveNotes() {
    if (notes === (item.notes || '')) return;
    try {
      setSavingNotes(true);
      const r = await api.patch(`/api/inventory/${item.oh_id}`, { notes });
      onUpdated(r.item || { ...item, notes });
    } finally {
      setSavingNotes(false);
    }
  }

  return (
    <>
      <div className={isManualSource(item.source) ? 'card card-manual' : 'card'} onClick={() => setOpen(true)}>
        <div className="card-head">
          <div className="card-society">{item.society || '—'}</div>
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
        </div>
        {item.stage === 'rejected' && item.reject_reason && (
          <div className="reject-reason">{REJECT_REASONS.find((r) => r.value === item.reject_reason)?.label || item.reject_reason}</div>
        )}
      </div>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal modal-card-detail" onClick={(e) => e.stopPropagation()}>
            <div className="card-detail-head">
              <div className="card-detail-title">
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
              <span>· asking <strong className="val-orange">{formatPrice(item.price)}</strong></span>
              {item.oh_price && <span>· OH <strong className="val-green">{formatPrice(item.oh_price)}</strong></span>}
            </div>

            <div className="exp-grid">
              <div>
                <span className="exp-lbl">Listing</span>
                <a href={item.listing_link} target="_blank" rel="noreferrer" className="exp-link">{item.listing_link}</a>
              </div>
              <div><span className="exp-lbl">Posted</span><span>{item.posting_date || '—'}</span></div>
              <div><span className="exp-lbl">Seller</span><span>{item.seller_name || '—'}</span></div>
              <div><span className="exp-lbl">Source</span><span>{item.source || '—'}</span></div>
              <div>
                <span className="exp-lbl">Asking Price</span>
                <span className="val-orange">{formatPrice(item.price)}</span>
              </div>
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
                onBlur={saveNotes}
                placeholder="Add a note…"
                rows={4}
                disabled={!canEdit}
              />
              {savingNotes && <div className="exp-saving">saving…</div>}
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
