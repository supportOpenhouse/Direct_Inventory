import { api } from '../api/client.js';
import {
  displayCity, formatDateRel, formatDateShort, formatPrice, isManualSource, starColor,
  STAGE_DOT_COLOR, stageLabel, variation,
} from '../utils/format.js';

const SORTABLE = new Set([
  'city', 'bedrooms', 'floor',
  'price', 'oh_price', 'variation', 'posting_date', 'follow_up_at',
]);

function SortableTh({ field, label, sort, onSort, align = 'left', className = '' }) {
  const active = sort?.field === field;
  const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
  function click() {
    if (!SORTABLE.has(field)) return;
    const nextDir = active ? (sort.dir === 'asc' ? 'desc' : 'asc') : 'desc';
    onSort({ field, dir: nextDir });
  }
  return (
    <th
      className={`inv-th inv-th-${align} ${SORTABLE.has(field) ? 'inv-th-sortable' : ''} ${active ? 'inv-th-active' : ''} ${className}`.trim()}
      onClick={click}
    >
      {label}
      <span className={active ? 'inv-th-arrow-active' : 'inv-th-arrow'}>{' '}{arrow}</span>
    </th>
  );
}

export default function InventoryTable({
  items, role, sort, onSort, onRowClick, onUpdated,
  selectMode = false, selected, onToggleSelect,
  showStageColumn = true,
}) {
  const canSetPriority = ['admin', 'manager', 'rm'].includes(role);
  // 16 base columns; +1 if selectMode, -1 if Stage hidden.
  const colCount = 16 + (selectMode ? 1 : 0) - (showStageColumn ? 0 : 1);

  async function togglePriority(e, item) {
    e.stopPropagation();
    if (!canSetPriority) return;
    // Star here doubles as "make yellow" / "clear yellow". Mirror the popup
    // picker: write `star_color` alongside `priority` so a stale override
    // (e.g. red/green/none picked earlier from the popup) doesn't keep
    // winning over the new yellow state.
    //   not yellow -> { star_color: 'yellow', priority: true }
    //   yellow     -> { star_color: null,     priority: false }  (falls back to cp_match)
    const wantYellow = starColor(item) !== 'yellow';
    const body = wantYellow
      ? { star_color: 'yellow', priority: true }
      : { star_color: null, priority: false };
    const optimistic = { ...item, ...body };
    onUpdated(optimistic);
    try {
      const r = await api.patch(`/api/inventory/${item.oh_id}`, body);
      if (r?.item) onUpdated(r.item);
    } catch (err) {
      onUpdated(item);
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
            <SortableTh field="city" label="City" sort={sort} onSort={onSort} />
            <th className="inv-th">Society</th>
            <SortableTh field="bedrooms" label="BHK" sort={sort} onSort={onSort} />
            <SortableTh field="floor" label="Floor" sort={sort} onSort={onSort} />
            <th className="inv-th">Area</th>
            <SortableTh field="price" label="Asking" sort={sort} onSort={onSort} align="right" />
            <SortableTh field="oh_price" label="OH Price" sort={sort} onSort={onSort} align="right" />
            <SortableTh field="variation" label="Variation" sort={sort} onSort={onSort} align="right" />
            {showStageColumn && <th className="inv-th">Stage</th>}
            <th className="inv-th">Seller</th>
            <th className="inv-th">Phone</th>
            <SortableTh field="posting_date" label="Posted" sort={sort} onSort={onSort} />
            <SortableTh field="follow_up_at" label="Follow-up" sort={sort} onSort={onSort} className="inv-th-date" />
            <th className="inv-th">Notes</th>
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
            const color = starColor(item);
            const rowClasses = [
              'inv-row',
              isManualSource(item.source) ? 'inv-row-manual' : '',
              color === 'yellow' ? 'inv-row-priority' : '',
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
                  {(color || canSetPriority) && (
                    <button
                      type="button"
                      className={`prio-star ${
                        color === 'yellow' ? 'prio-on'
                          : color === 'green' ? 'cp-perfect'
                          : color === 'red' ? 'cp-partial'
                          : 'prio-off'
                      }`}
                      onClick={(e) => togglePriority(e, item)}
                      disabled={!canSetPriority}
                      title={
                        item.star_color
                          ? `Manual ${item.star_color} star — open card to change`
                          : color === 'yellow'
                            ? ((item.cp_match === 'perfect' || item.cp_match === 'partial')
                                ? `Priority lead (also a ${item.cp_match} CP Inventory match)`
                                : 'Priority lead — click to unmark')
                            : color === 'green'
                              ? 'Perfect CP Inventory match — society + BHK + floor + tower + unit_no'
                              : color === 'red'
                                ? 'Partial CP Inventory match — society + BHK + floor'
                                : (canSetPriority ? 'Mark Priority' : 'Priority')
                      }
                      aria-label={
                        color === 'yellow' ? 'Priority lead'
                          : color === 'green' ? 'perfect CP match'
                          : color === 'red' ? 'partial CP match'
                          : 'Mark as Priority'
                      }
                    >★</button>
                  )}
                </td>
                <td className="inv-td-id">{item.oh_id}</td>
                <td><span className="city-chip">{displayCity(item.city)?.toUpperCase()}</span></td>
                <td className="inv-td-society">{item.society || '—'}</td>
                <td>{item.bedrooms != null ? `${item.bedrooms} BHK` : '—'}</td>
                <td>{item.floor != null && item.floor !== '' ? item.floor : '—'}</td>
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
                <td className="inv-td-muted inv-td-date">{formatDateShort(item.follow_up_at)}</td>
                <td className="inv-td-notes" title={item.notes || ''}>{item.notes || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
