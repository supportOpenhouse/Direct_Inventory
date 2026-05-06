import { useState } from 'react';
import { api } from '../api/client.js';
import { formatPrice, formatDateRel, REJECT_REASONS, STAGE_DOT_COLOR, stageLabel } from '../utils/format.js';
import VisitScheduleModal from './VisitScheduleModal.jsx';

export default function InventoryCard({ item, onUpdated, role }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(item.notes || '');
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingStage, setSavingStage] = useState(false);
  const [showVisit, setShowVisit] = useState(false);
  const [pendingStage, setPendingStage] = useState(null);
  const canEdit = ['admin', 'manager', 'rm'].includes(role);

  async function changeStage(newStage) {
    if (newStage === item.stage) return;
    if (newStage === 'visit_scheduled') {
      setPendingStage(newStage);
      setShowVisit(true);
      return;
    }
    let body = { stage: newStage };
    if (newStage === 'rejected') {
      const reason = window.prompt(
        `Reject reason — one of:\n${REJECT_REASONS.map((r) => `• ${r.value} (${r.label})`).join('\n')}`,
      );
      if (!reason) return;
      body.reject_reason = reason;
    }
    try {
      setSavingStage(true);
      const r = await api.patch(`/api/inventory/${item.oh_id}`, body);
      onUpdated(r.item || { ...item, ...body });
    } finally {
      setSavingStage(false);
    }
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
      <div className="card" onClick={() => setOpen((v) => !v)}>
        <div className="card-head">
          <div className="card-society">{item.society || '—'}</div>
          <div className="card-meta">
            <span className="city-chip">{item.city?.toUpperCase()}</span>
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
        <div className="card-expand" onClick={(e) => e.stopPropagation()}>
          <div className="exp-grid">
            <div><span className="exp-lbl">Listing</span>
              <a href={item.listing_link} target="_blank" rel="noreferrer" className="exp-link">{item.listing_link}</a>
            </div>
            <div><span className="exp-lbl">Posted</span><span>{item.posting_date || '—'}</span></div>
            <div><span className="exp-lbl">Seller</span><span>{item.seller_name || '—'}</span></div>
            <div><span className="exp-lbl">Source</span><span>{item.source || '—'}</span></div>
          </div>
          {canEdit && (
            <div className="exp-actions">
              <label>Stage</label>
              <select
                value={item.stage}
                onChange={(e) => changeStage(e.target.value)}
                disabled={savingStage}
              >
                {['qualified','follow_up_cnr','visit_scheduled','visit_completed','offer_given','unreachable','rejected'].map((s) => (
                  <option key={s} value={s}>{stageLabel(s)}</option>
                ))}
              </select>
            </div>
          )}
          <div className="exp-notes">
            <label>Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={saveNotes}
              placeholder="Add a note…"
              rows={3}
              disabled={!canEdit}
            />
            {savingNotes && <div className="exp-saving">saving…</div>}
          </div>
        </div>
      )}

      {showVisit && (
        <VisitScheduleModal
          item={item}
          onClose={() => { setShowVisit(false); setPendingStage(null); }}
          onScheduled={(updated) => { setShowVisit(false); onUpdated(updated); }}
        />
      )}
    </>
  );
}
