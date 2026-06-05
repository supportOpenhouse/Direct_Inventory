import { useState } from 'react';
import NoteThread from './NoteThread.jsx';
import StatusEditModal from './StatusEditModal.jsx';
import EditDetailsModal from './EditDetailsModal.jsx';
import OhPrice from './OhPrice.jsx';
import { formatDateShort, formatPrice, STAGE_DOT_COLOR, stageLabel, supplyReasonLabel, variation } from '../utils/format.js';

function Field({ label, children }) {
  return (
    <div className="field-row">
      <span className="field-lbl">{label}</span>
      <span className="field-val">{children ?? '—'}</span>
    </div>
  );
}

/**
 * Inline drill-down panel revealed beneath a clicked table row.
 * Distributed columns: Property Details · Pricing · Seller Details · Notes.
 * `sections` lets a host trim what's shown (Leads keeps it lean).
 */
export default function ExpandPanel({ item, role, onUpdated, canPost = true, sections, canEditStatus = true }) {
  const show = sections || ['property', 'pricing', 'seller', 'notes'];
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

      {showStatus && (
        <StatusEditModal item={item} onUpdated={(u) => onUpdated?.(u)} onClose={() => setShowStatus(false)} />
      )}
      {showEdit && (
        <EditDetailsModal item={item} onUpdated={(u) => onUpdated?.(u)} onClose={() => setShowEdit(false)} />
      )}
    </div>
  );
}
