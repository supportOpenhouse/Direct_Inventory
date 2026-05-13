import { api } from '../api/client.js';
import {
  displayCity, formatDateRel, formatPrice, isManualSource,
  STAGE_DOT_COLOR, stageLabel, variation,
} from '../utils/format.js';

const SORTABLE = new Set(['price', 'oh_price', 'variation', 'posting_date', 'follow_up_at']);

function SortableTh({ field, label, sort, onSort, align = 'left' }) {
  const active = sort?.field === field;
  const arrow = !active ? '' : (sort.dir === 'asc' ? ' ▲' : ' ▼');
  function click() {
    if (!SORTABLE.has(field)) return;
    const nextDir = active ? (sort.dir === 'asc' ? 'desc' : 'asc') : 'desc';
    onSort({ field, dir: nextDir });
  }
  return (
    <th
      className={`inv-th inv-th-${align} ${SORTABLE.has(field) ? 'inv-th-sortable' : ''} ${active ? 'inv-th-active' : ''}`}
      onClick={click}
    >
      {label}{arrow}
    </th>
  );
}

export default function InventoryTable({
  items, role, sort, onSort, onRowClick, onUpdated,
  selectMode = false, selected, onToggleSelect,
  showStageColumn = true,
}) {
  const canSetPriority = ['admin', 'manager'].includes(role);
  // 14 base columns; +1 if selectMode, -1 if Stage hidden.
  const colCount = 14 + (selectMode ? 1 : 0) - (showStageColumn ? 0 : 1);

  async function togglePriority(e, item) {
    e.stopPropagation();
    if (!canSetPriority) return;
    const next = !item.priority;
    onUpdated({ ...item, priority: next });   // optimistic
    try {
      const r = await api.patch(`/api/inventory/${item.oh_id}`, { priority: next });
      if (r?.item) onUpdated(r.item);
    } catch (err) {
      onUpdated({ ...item, priority: !next });
      console.error('priority toggle failed', err);
    }
  }

  return (
    <div className="inv-table-wrap">
      <table className="inv-table">
        <thead>
          <tr>
            {selectMode && <th className="inv-th inv-th-sel"></th>}
            <th className="inv-th inv-th-star"></th>
            <th className="inv-th">OH-ID</th>
            <th className="inv-th">City</th>
            <th className="inv-th">Society</th>
            <th className="inv-th">BHK</th>
            <th className="inv-th">Area</th>
            <SortableTh field="price" label="Asking" sort={sort} onSort={onSort} align="right" />
            <SortableTh field="oh_price" label="OH Price" sort={sort} onSort={onSort} align="right" />
            <SortableTh field="variation" label="Variation" sort={sort} onSort={onSort} align="right" />
            {showStageColumn && <th className="inv-th">Stage</th>}
            <th className="inv-th">Seller</th>
            <th className="inv-th">Phone</th>
            <SortableTh field="posting_date" label="Posted" sort={sort} onSort={onSort} />
            <SortableTh field="follow_up_at" label="Follow-up" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr><td className="inv-empty" colSpan={colCount}>No matching rows.</td></tr>
          )}
          {items.map((item) => {
            const v = variation(item.price, item.oh_price);
            const isNearest = item.oh_price_match === 'nearest';
            const isSel = selected?.has?.(item.oh_id);
            const rowClasses = [
              'inv-row',
              isManualSource(item.source) ? 'inv-row-manual' : '',
              item.priority ? 'inv-row-priority' : '',
              isSel ? 'inv-row-selected' : '',
            ].filter(Boolean).join(' ');

            return (
              <tr
                key={item.oh_id}
                className={rowClasses}
                onClick={() => (selectMode ? onToggleSelect?.(item.oh_id) : onRowClick?.(item))}
              >
                {selectMode && (
                  <td className="inv-td-sel" onClick={(e) => { e.stopPropagation(); onToggleSelect?.(item.oh_id); }}>
                    <input type="checkbox" readOnly checked={!!isSel} />
                  </td>
                )}
                <td className="inv-td-star">
                  {(item.priority || canSetPriority) && (
                    <button
                      type="button"
                      className={`prio-star ${item.priority ? 'prio-on' : 'prio-off'}`}
                      onClick={(e) => togglePriority(e, item)}
                      disabled={!canSetPriority}
                      title={canSetPriority
                        ? (item.priority ? 'Unmark Priority' : 'Mark Priority')
                        : 'Priority'}
                      aria-label={item.priority ? 'Priority lead' : 'Mark as Priority'}
                    >★</button>
                  )}
                </td>
                <td className="inv-td-id">{item.oh_id}</td>
                <td><span className="city-chip">{displayCity(item.city)?.toUpperCase()}</span></td>
                <td className="inv-td-society">{item.society || '—'}</td>
                <td>{item.bedrooms != null ? `${item.bedrooms} BHK` : '—'}</td>
                <td>{item.area_sqft != null ? `${item.area_sqft} sqft` : '—'}</td>
                <td className="inv-td-num val-orange">{formatPrice(item.price)}</td>
                <td className={`inv-td-num ${item.oh_price ? (isNearest ? 'val-amber' : 'val-green') : 'muted'}`}>
                  {item.oh_price ? `${isNearest ? '~' : ''}${formatPrice(item.oh_price)}` : '—'}
                </td>
                <td className={`inv-td-num ${v ? `val-var-${v.sign}` : 'muted'}`}>
                  {v ? v.label : '—'}
                </td>
                {showStageColumn && (
                  <td>
                    <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[item.stage] }} />
                    <span className="inv-td-stage-lbl">{stageLabel(item.stage)}</span>
                  </td>
                )}
                <td className="inv-td-seller">{item.seller_name || '—'}</td>
                <td className="inv-td-phone">{item.seller_phone || '—'}</td>
                <td className="inv-td-muted">{item.created_at ? formatDateRel(item.created_at) : '—'}</td>
                <td className="inv-td-muted">{item.follow_up_at ? item.follow_up_at.slice(0, 10) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
