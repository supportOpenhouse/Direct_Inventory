import { api } from '../api/client.js';
import {
  displayCity, formatDateRel, formatDateShort, formatPrice, rowFlag, starColor,
  STAGE_DOT_COLOR, stageLabel, variation,
} from '../utils/format.js';

const SORTABLE = new Set([
  'oh_id', 'city', 'society', 'bedrooms', 'floor', 'area_sqft',
  'price', 'oh_price', 'variation', 'stage', 'seller_name', 'seller_phone',
  'posting_date', 'created_at', 'follow_up_at',
]);

// Compact RM-list label for the board's RM column: "First Name +N" when a
// property has multiple RMs, just the name when one, "—" when unassigned.
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

// Pick the most recent note from a `note_thread` array (matches the ordering
// used in CardDetailModal's NoteThread).
function latestNote(thread) {
  if (!Array.isArray(thread) || thread.length === 0) return null;
  let best = null;
  for (const n of thread) {
    if (!n) continue;
    if (!best || new Date(n.created_at).getTime() > new Date(best.created_at).getTime()) {
      best = n;
    }
  }
  return best;
}

// Avatar helpers — mirror CardDetailModal's Avatar so a person's initials and
// tint stay consistent between the board column and the per-property popup.
function initialsOf(name, email) {
  const s = (name || (email || '').split('@')[0] || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
function avatarStyle(key) {
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { background: `hsl(${hue}, 65%, 88%)`, color: `hsl(${hue}, 55%, 28%)` };
}

// Placeholder rows shown while a page is loading — keeps the table (and its
// header) on screen instead of swapping in a "Loading…" message.
const SKELETON_ROWS = 10;

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
  selectMode = false, selected, onToggleSelect, onToggleSelectAll,
  showStageColumn = true, loading = false,
}) {
  // Header checkbox state — tristate over the currently visible (paged) rows.
  const visibleIds = items.map((it) => it.oh_id);
  const visibleSelectedCount = visibleIds.filter((id) => selected?.has?.(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  const canSetPriority = ['admin', 'manager', 'rm'].includes(role);
  const showRmColumn = role === 'admin' || role === 'manager';
  // RMs don't need OH-ID / City / RM in the table — they only see their own
  // assigned leads, and the popup still surfaces the OH-ID + city.
  const showIdColumn = role !== 'rm';
  const showCityColumn = role !== 'rm';
  // 17 base columns; +1 if selectMode, -1 each for hidden OH-ID/City/Stage, +1 if RM column shown.
  const colCount = 17
    + (selectMode ? 1 : 0)
    - (showIdColumn ? 0 : 1)
    - (showCityColumn ? 0 : 1)
    - (showStageColumn ? 0 : 1)
    + (showRmColumn ? 1 : 0);

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
            {selectMode && (
              <th className="inv-th inv-th-sel">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                  onChange={() => onToggleSelectAll?.(visibleIds)}
                  title={allVisibleSelected
                    ? 'Deselect all on this page'
                    : 'Select all on this page'}
                  aria-label="Select all rows on this page"
                />
              </th>
            )}
            <th className="inv-th inv-th-star"></th>
            {showIdColumn && <SortableTh field="oh_id" label="OH-ID" sort={sort} onSort={onSort} />}
            {showCityColumn && <SortableTh field="city" label="City" sort={sort} onSort={onSort} />}
            {showRmColumn && <th className="inv-th">RM</th>}
            <SortableTh field="society" label="Society" sort={sort} onSort={onSort} />
            <SortableTh field="bedrooms" label="BHK" sort={sort} onSort={onSort} />
            <SortableTh field="floor" label="Floor" sort={sort} onSort={onSort} />
            <SortableTh field="area_sqft" label="Area" sort={sort} onSort={onSort} />
            <SortableTh field="price" label="Asking" sort={sort} onSort={onSort} align="right" />
            <SortableTh field="oh_price" label="OH Price" sort={sort} onSort={onSort} align="right" />
            <SortableTh field="variation" label="Variation" sort={sort} onSort={onSort} align="right" />
            {showStageColumn && <SortableTh field="stage" label="Stage" sort={sort} onSort={onSort} />}
            <SortableTh field="follow_up_at" label="Follow-up" sort={sort} onSort={onSort} className="inv-th-date" />
            <SortableTh field="seller_name" label="Seller" sort={sort} onSort={onSort} />
            <SortableTh field="seller_phone" label="Phone" sort={sort} onSort={onSort} />
            <SortableTh field="posting_date" label="Posted At" sort={sort} onSort={onSort} />
            <SortableTh field="created_at" label="Created At" sort={sort} onSort={onSort} />
            <th className="inv-th">Notes</th>
          </tr>
        </thead>
        <tbody>
          {loading && Array.from({ length: SKELETON_ROWS }).map((_, r) => (
            <tr className="inv-row inv-row-skeleton" key={`skel-${r}`}>
              {Array.from({ length: colCount }).map((_, c) => (
                <td key={c}><span className="inv-skel" /></td>
              ))}
            </tr>
          ))}
          {!loading && items.length === 0 && (
            <tr><td className="inv-empty" colSpan={colCount}>No matching rows.</td></tr>
          )}
          {!loading && items.map((item) => {
            const v = variation(item.price, item.oh_price);
            const isNearest = item.oh_price_match === 'nearest';
            const isSel = selected?.has?.(item.oh_id);
            const color = starColor(item);
            // Overdue follow-up (yellow) / stale Lead (red) — colours the
            // OH-ID, City and Society cells. See rowFlag() in format.js.
            const flag = rowFlag(item);
            const flagCls = flag ? `inv-td-flag-${flag}` : '';
            const rowClasses = [
              'inv-row',
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
                {showIdColumn && (
                  <td className={`inv-td-id ${flagCls}`.trim()}>{item.oh_id}</td>
                )}
                {showCityColumn && (
                  <td className={flagCls}><span className="city-chip">{displayCity(item.city)?.toUpperCase()}</span></td>
                )}
                {showRmColumn && (
                  <td className="inv-td-muted" title={assignedRmsTitle(item.assigned_rms)}>
                    {formatAssignedRms(item.assigned_rms)}
                  </td>
                )}
                <td className={`inv-td-society ${flagCls}`.trim()}>
                  {item.society || '—'}
                </td>
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
                <td className="inv-td-muted inv-td-date">{formatDateShort(item.follow_up_at)}</td>
                <td className="inv-td-seller">{item.seller_name || '—'}</td>
                <td className="inv-td-phone">{item.seller_phone || '—'}</td>
                <td className="inv-td-muted">{formatDateShort(item.posting_date)}</td>
                <td className="inv-td-muted">{item.created_at ? formatDateRel(item.created_at) : '—'}</td>
                {(() => {
                  const n = latestNote(item.note_thread);
                  if (!n) return <td className="inv-td-notes">—</td>;
                  const who = n.author_name || n.author_email || '';
                  return (
                    <td className="inv-td-notes" title={`${who}: ${n.body}`}>
                      <span
                        className="note-av note-av-sm inv-td-notes-av"
                        style={avatarStyle(n.author_email || n.author_name)}
                      >
                        {initialsOf(n.author_name, n.author_email)}
                      </span>
                      <span className="inv-td-notes-body">{n.body}</span>
                    </td>
                  );
                })()}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
