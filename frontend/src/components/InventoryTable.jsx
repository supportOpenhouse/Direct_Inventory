import { Fragment, useState } from 'react';
import { api } from '../api/client.js';
import ExpandPanel from './ExpandPanel.jsx';
import OhPrice from './OhPrice.jsx';
import {
  displayCity, formatDateRel, formatDateShort, formatPrice, isCreatedToday, reasonLabelAny, rowFlag, starColor,
  STAGE_DOT_COLOR, stageLabel, variation,
} from '../utils/format.js';

const SORTABLE = new Set([
  'oh_id', 'city', 'society', 'bedrooms', 'floor', 'area_sqft',
  'price', 'oh_price', 'variation', 'stage', 'seller_name', 'seller_phone',
  'posting_date', 'created_at', 'follow_up_at',
]);

function latestNote(thread) {
  if (!Array.isArray(thread) || thread.length === 0) return null;
  return thread.reduce((best, n) => (!best || new Date(n.created_at) > new Date(best.created_at) ? n : best), null);
}

// Initials of a note author — "Jyoti Singh" -> "JS", "ravi@openhouse.in" -> "RA".
function authorInitials(note) {
  const src = (note?.author_name || '').trim() || (note?.author_email || '').split('@')[0] || '';
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Assigned RMs are joined onto each row as [{id, name, email}, ...].
function formatAssignedRms(rms) {
  if (!Array.isArray(rms) || rms.length === 0) return '—';
  const first = rms[0];
  const label = first.name || first.email || `#${first.id}`;
  const extra = rms.length - 1;
  return extra > 0 ? `${label} +${extra}` : label;
}
function assignedRmsTitle(rms) {
  if (!Array.isArray(rms) || rms.length === 0) return '';
  return rms.map((r) => r.name || r.email || `#${r.id}`).join(', ');
}

function SortTh({ field, label, sort, onSort, align = 'left', cls = '' }) {
  const active = sort?.field === field;
  const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
  function click() {
    if (!SORTABLE.has(field)) return;
    onSort({ field, dir: active ? (sort.dir === 'asc' ? 'desc' : 'asc') : 'desc' });
  }
  return (
    <th
      className={`inv-th ${cls} ${align === 'right' ? 'inv-th-right' : ''} ${SORTABLE.has(field) ? 'inv-th-sortable' : ''} ${active ? 'inv-th-active' : ''}`}
      onClick={click}
    >
      {label} <span className={active ? 'inv-th-arrow-active' : 'inv-th-arrow'}>{arrow}</span>
    </th>
  );
}

const SKELETON_ROWS = 8;

export default function InventoryTable({
  items, role, sort, onSort, onUpdated, loading = false,
  selectMode = false, selected, onToggleSelect, onToggleSelectAll, allowStatusEdit = true,
  showReasonCol = false,
}) {
  const [openId, setOpenId] = useState(null);
  const canSetPriority = ['admin', 'manager', 'rm'].includes(role);
  const isAdmin = role === 'admin';
  // 16 always-on columns + OH-ID + Assigned RM (admin only) + select checkbox
  // + optional Reason column.
  const colCount = 16 + (isAdmin ? 2 : 0) + (selectMode ? 1 : 0) + (showReasonCol ? 1 : 0);

  // Header checkbox state — tristate over the currently rendered (paged) rows.
  const visibleIds = items.map((it) => it.oh_id);
  const visibleSelectedCount = visibleIds.filter((id) => selected?.has?.(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;

  async function togglePriority(e, item) {
    e.stopPropagation();
    if (!canSetPriority) return;
    const wantYellow = starColor(item) !== 'yellow';
    const body = wantYellow ? { star_color: 'yellow', priority: true } : { star_color: null, priority: false };
    onUpdated({ ...item, ...body });
    try {
      const r = await api.patch(`/api/inventory/${item.oh_id}`, body);
      if (r?.item) onUpdated(r.item);
    } catch { onUpdated(item); }
  }

  return (
    <div className="inv-table-wrap">
      <table className="inv-table">
        <thead>
          <tr>
            {selectMode && (
              <th className="inv-th inv-th-sel">
                <input type="checkbox" checked={allVisibleSelected}
                  ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                  onChange={() => onToggleSelectAll?.(visibleIds)}
                  title={allVisibleSelected ? 'Deselect all on this page' : 'Select all on this page'}
                  aria-label="Select all rows on this page" />
              </th>
            )}
            <th className="inv-th inv-th-star" />
            {isAdmin && <SortTh field="oh_id" label="OH-ID" sort={sort} onSort={onSort} />}
            <SortTh field="city" label="City" sort={sort} onSort={onSort} />
            <SortTh field="society" label="Society" sort={sort} onSort={onSort} cls="inv-col-society" />
            <SortTh field="bedrooms" label="BHK" sort={sort} onSort={onSort} cls="inv-col-bhk" />
            <SortTh field="floor" label="Floor" sort={sort} onSort={onSort} />
            <SortTh field="area_sqft" label="Area" sort={sort} onSort={onSort} cls="inv-col-area" />
            <SortTh field="price" label="Asking" sort={sort} onSort={onSort} align="right" cls="inv-col-asking" />
            <SortTh field="oh_price" label="OH Price" sort={sort} onSort={onSort} align="right" cls="inv-col-oh" />
            <SortTh field="variation" label="Variation" sort={sort} onSort={onSort} align="right" />
            <SortTh field="stage" label="Stage" sort={sort} onSort={onSort} cls="inv-col-stage" />
            {showReasonCol && <th className="inv-th inv-col-reason">Reason</th>}
            <SortTh field="follow_up_at" label="Follow-up" sort={sort} onSort={onSort} cls="inv-col-followup" />
            <SortTh field="seller_name" label="Seller" sort={sort} onSort={onSort} />
            <SortTh field="seller_phone" label="Phone" sort={sort} onSort={onSort} />
            <SortTh field="posting_date" label="Posted" sort={sort} onSort={onSort} cls="inv-col-posted" />
            <SortTh field="created_at" label="Created" sort={sort} onSort={onSort} />
            {isAdmin && <th className="inv-th">Assigned RM</th>}
            <th className="inv-th">Notes</th>
          </tr>
        </thead>
        <tbody>
          {loading && Array.from({ length: SKELETON_ROWS }).map((_, r) => (
            <tr className="inv-row" key={`s-${r}`}>
              {Array.from({ length: colCount }).map((__, c) => <td key={c}><span className="inv-skel" /></td>)}
            </tr>
          ))}
          {!loading && items.length === 0 && (
            <tr><td className="inv-empty" colSpan={colCount}>No matching rows.</td></tr>
          )}
          {!loading && items.map((item) => {
            const v = variation(item.price, item.oh_price);
            const color = starColor(item);
            const flag = rowFlag(item);
            const isOpen = openId === item.oh_id;
            const isSel = selected?.has?.(item.oh_id);
            const note = latestNote(item.note_thread);
            return (
              <Fragment key={item.oh_id}>
                <tr
                  className={`inv-row ${color === 'yellow' ? 'inv-row-priority' : ''} ${isOpen ? 'inv-row-open' : ''} ${isSel ? 'inv-row-selected' : ''}`}
                  onClick={() => (selectMode ? onToggleSelect?.(item.oh_id) : setOpenId(isOpen ? null : item.oh_id))}
                >
                  {selectMode && (
                    <td className="inv-td-sel" onClick={(e) => { e.stopPropagation(); onToggleSelect?.(item.oh_id); }}>
                      <input type="checkbox" readOnly checked={!!isSel} />
                    </td>
                  )}
                  <td className="inv-td-star">
                    {(color || canSetPriority) && (
                      <button
                        type="button"
                        className={`prio-star ${color === 'yellow' ? 'prio-on' : color === 'green' ? 'cp-perfect' : color === 'red' ? 'cp-partial' : 'prio-off'}`}
                        onClick={(e) => togglePriority(e, item)}
                        disabled={!canSetPriority}
                        title="Priority"
                      >★</button>
                    )}
                  </td>
                  {isAdmin && <td className="inv-td-id">{item.oh_id}</td>}
                  <td><span className="city-chip">{displayCity(item.city)?.toUpperCase()}</span></td>
                  <td className={`inv-td-society ${flag ? `inv-society-${flag}` : ''}`}>
                    <span className="inv-clip inv-clip-society" title={item.society || ''}>{item.society || '—'}</span>
                    {isCreatedToday(item.created_at) && <img className="new-badge-img" src="/new.png" alt="NEW" />}
                  </td>
                  <td className="inv-col-bhk">{item.bedrooms != null ? `${item.bedrooms} BHK` : '—'}</td>
                  <td>{item.floor || '—'}</td>
                  <td className="inv-col-area">{item.area_sqft != null ? `${item.area_sqft} sqft` : '—'}</td>
                  <td className="inv-td-num val-orange inv-col-asking">{formatPrice(item.price)}</td>
                  <td className="inv-td-num inv-col-oh"><OhPrice item={item} /></td>
                  <td className={`inv-td-num ${v ? `val-var-${v.sign}` : 'muted'}`}>{v ? v.label : '—'}</td>
                  <td className="inv-col-stage">
                    <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[item.stage] }} />{stageLabel(item.stage)}
                    {item.stage === 'visit_scheduled' && item.visit_overdue && <span className="stage-overdue">Overdue</span>}
                  </td>
                  {showReasonCol && (
                    <td className="inv-td-muted inv-col-reason">
                      {item.stage_reason ? <span className="inv-clip" title={reasonLabelAny(item.stage_reason)}>{reasonLabelAny(item.stage_reason)}</span> : '—'}
                    </td>
                  )}
                  <td className="inv-td-muted inv-col-followup">{formatDateShort(item.follow_up_at)}</td>
                  <td><span className="inv-clip inv-clip-seller" title={item.seller_name || ''}>{item.seller_name || '—'}</span></td>
                  <td className="inv-td-muted">{item.seller_phone || '—'}</td>
                  <td className="inv-td-muted inv-col-posted">{formatDateShort(item.posting_date)}</td>
                  <td className="inv-td-muted">{item.created_at ? formatDateRel(item.created_at) : '—'}</td>
                  {isAdmin && <td className="inv-td-muted" title={assignedRmsTitle(item.assigned_rms)}><span className="inv-clip inv-clip-rm">{formatAssignedRms(item.assigned_rms)}</span></td>}
                  <td className="inv-td-notes">
                    {note ? (
                      <span className="inv-td-notes-wrap">
                        <span className="note-initials" title={note.author_name || note.author_email || ''}>{authorInitials(note)}</span>
                        <span className="inv-td-notes-body" title={note.body}>{note.body}</span>
                      </span>
                    ) : '—'}
                  </td>
                </tr>
                {isOpen && !selectMode && (
                  <tr className="expand-row">
                    <td colSpan={colCount}>
                      <ExpandPanel item={item} role={role} onUpdated={onUpdated} canPost={canSetPriority} canEditStatus={allowStatusEdit} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
