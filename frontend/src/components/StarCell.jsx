import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { starColor, starClass } from '../utils/format.js';

// Picker swatches, in display order. `none` clears the star.
const SWATCHES = [
  { value: 'yellow', color: 'var(--yellow)', label: 'Important' },
  { value: 'green', color: 'var(--green)', label: 'Perfect' },
  { value: 'red', color: 'var(--red)', label: 'Partial' },
  { value: 'pink', color: '#fd4ad8', label: 'Reassign (Admin)' },
  { value: 'blue', color: '#02f5d0', label: 'Reassign (Mgr)' },
  { value: 'none', color: 'var(--text-faint)', label: 'Clear' },
];

/**
 * Star cell with a floating colour picker. Clicking the star opens a popover to
 * its right; picking a swatch writes star_color directly (yellow also sets
 * priority; everything else clears it). Touching a reassigned lead acknowledges
 * it (clears the reassigned flag). Shared by InventoryTable / Leads /
 * QualifiedLeads so the star behaves identically everywhere.
 */
export default function StarCell({ item, canSet, onUpdated }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const color = starColor(item);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function pick(e, value) {
    e.stopPropagation();
    setOpen(false);
    // yellow ⇒ priority; every other colour (and clear) ⇒ not priority.
    const body = { star_color: value, priority: value === 'yellow' };
    if (item.reassigned) body.reassigned = false; // manual touch = acknowledged
    onUpdated({ ...item, ...body, ...(value === 'none' ? { star_color: 'none' } : {}) });
    try { const r = await api.patch(`/api/inventory/${item.oh_id}`, body); if (r?.item) onUpdated(r.item); }
    catch { onUpdated(item); }
  }

  if (!color && !canSet) return <td className="inv-td-star" />;
  return (
    <td className="inv-td-star" ref={ref} style={{ position: 'relative', overflow: 'visible' }}>
      <button type="button" disabled={!canSet} title="Star"
        className={`prio-star ${starClass(color)}`}
        onClick={(e) => { e.stopPropagation(); if (canSet) setOpen((o) => !o); }}>★</button>
      {open && (
        <div className="star-picker" onClick={(e) => e.stopPropagation()}>
          {SWATCHES.map((s) => (
            <button key={s.value} type="button" className="star-swatch" title={s.label}
              style={{ color: s.color }} onClick={(e) => pick(e, s.value)}>
              {s.value === 'none' ? '⊘' : '★'}
            </button>
          ))}
        </div>
      )}
    </td>
  );
}
