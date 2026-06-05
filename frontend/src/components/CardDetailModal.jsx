import { useEffect } from 'react';
import ExpandPanel from './ExpandPanel.jsx';
import { displayCity, formatPrice, STAGE_DOT_COLOR, stageLabel } from '../utils/format.js';
import { IconClose } from './icons.jsx';

/**
 * Read/notes detail popup for a single inventory row. Used by the notification
 * bell. Editing is delegated to the inline ExpandPanel sections; this is mainly
 * a focused view of one lead with its notes thread.
 */
export default function CardDetailModal({ item, role, onUpdated, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canPost = ['admin', 'manager', 'rm'].includes(role);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head-row">
          <h3>{item.society || '—'}</h3>
          <span className="city-chip">{displayCity(item.city)?.toUpperCase()}</span>
          <span className="role-chip">{item.oh_id}</span>
          <span className="stage-dot stage-dot-lg" style={{ background: STAGE_DOT_COLOR[item.stage] }} />
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{stageLabel(item.stage)}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>
        <div className="muted" style={{ marginBottom: 14 }}>
          {[item.locality, item.bedrooms != null ? `${item.bedrooms} BHK` : null, item.area_sqft != null ? `${item.area_sqft} sqft` : null]
            .filter(Boolean).join(' · ')} · <strong className="val-orange">{formatPrice(item.price)}</strong>
        </div>
        <div className="inv-table-wrap" style={{ overflow: 'visible' }}>
          <ExpandPanel item={item} role={role} onUpdated={onUpdated} canPost={canPost} />
        </div>
      </div>
    </div>
  );
}
