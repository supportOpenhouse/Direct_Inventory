import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { formatDateShort, formatPrice } from '../utils/format.js';
import { IconClose, IconExternal } from './icons.jsx';
import { useModalExit } from '../utils/useModalExit.js';

// A CP submission's page on the CP Inventory Portal, keyed by its public id.
const CP_PORTAL = 'https://cp-inventory-portal.vercel.app/';

/**
 * Every CP submission behind a lead's cp_match verdict — perfect first, then
 * partial. Opened from the star's tick ring (StarCell). The ids come from
 * inventory.cp_match_ids (stored by the CP scan); details are read live from
 * the CP DB, so a submission's status/price here is current.
 */
export default function CpMatchesModal({ item, onClose: rawClose }) {
  const { onClose, backdropClass } = useModalExit(rawClose);
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get(`/api/inventory/${encodeURIComponent(item.oh_id)}/cp-matches`, { silent: true })
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) setError(e.data?.error || e.message); });
    return () => { alive = false; };
  }, [item.oh_id]);

  const items = data?.items || [];
  const perfect = items.filter((m) => m.match === 'perfect').length;

  return (
    <div className={backdropClass} onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head-row">
          <h3>CP Matches</h3>
          <span className="role-chip">{item.oh_id}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>
        <p className="modal-sub">
          {item.society || '—'}
          {data?.scanned && items.length > 0 && ` · ${perfect} perfect · ${items.length - perfect} partial`}
        </p>

        {error && <div className="modal-error">{error}</div>}
        {!error && data === null && <div className="muted">Loading matches…</div>}
        {data && !data.scanned && (
          <div className="muted">Not scanned yet — run <strong>CP Scan</strong> to list the matching submissions.</div>
        )}
        {data?.scanned && items.length === 0 && <div className="muted">No matching CP submissions.</div>}

        {items.length > 0 && (
          <ul className="cpm-list">
            {items.map((m) => {
              // Cards with a public id open it on the CP portal; the rest stay inert.
              const href = !m.missing && m.public_id ? CP_PORTAL + encodeURIComponent(m.public_id) : null;
              const Card = href ? 'a' : 'div';
              return (
              <li key={m.id}>
                <Card className={`cpm-item${href ? ' cpm-link' : ''}`}
                  {...(href && { href, target: '_blank', rel: 'noreferrer', title: `Open ${m.public_id} on CP portal` })}>
                <span className={`cpm-kind cpm-kind-${m.match}`}>{m.match === 'perfect' ? 'Perfect' : 'Partial'}</span>
                {m.missing ? (
                  <div className="cpm-body muted">Submission #{m.id} no longer exists in CP.</div>
                ) : (
                  <div className="cpm-body">
                    <div className="cpm-title">
                      {[m.tower && `Tower ${m.tower}`, m.unit_no && `Unit ${m.unit_no}`, m.floor && `Floor ${m.floor}`]
                        .filter(Boolean).join(' · ') || <span className="muted">No tower / unit on file</span>}
                    </div>
                    <div className="cpm-meta">
                      {[m.bhk != null && `${m.bhk} BHK`, m.sqft != null && `${m.sqft} sqft`,
                        m.asking_price ? formatPrice(m.asking_price) : null, m.status]
                        .filter(Boolean).join(' · ')}
                    </div>
                    <div className="cpm-meta">
                      {m.public_id || `#${m.id}`} · {formatDateShort(m.submitted_at)}
                      {m.submitted_by_name && ` · by ${m.submitted_by_name}`}
                    </div>
                  </div>
                )}
                {href && <span className="cpm-go"><IconExternal size={14} /></span>}
                </Card>
              </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
