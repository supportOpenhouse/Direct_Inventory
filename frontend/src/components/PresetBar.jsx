/**
 * Saved filter presets — three slots in the Filters modal header.
 *
 * Ordering IS priority. The leftmost preset is the one that auto-applies when
 * the user's local filter store has aged out (12h), so dragging a preset to
 * the front is what promotes it — there's no separate "make this the default"
 * toggle to drift out of sync with the order. The backend enforces the same
 * rule (`ufp_priority_is_first`), so the two can't disagree.
 *
 * Two invariants keep that honest, both applied by `normalise()` on every
 * mutation:
 *   1. Occupied slots are packed to the FRONT of `sequence` (empties trail).
 *      Without this, deleting the leading preset leaves an empty slot at
 *      sequence[0] and the document ends up with no priority at all, even
 *      though presets remain.
 *   2. priority = the first occupied slot in `sequence`, i.e. exactly the
 *      chip the user sees on the far left.
 *
 * Drag-and-drop is the native HTML5 API — no library for three chips. The drop
 * target is the whole ROW, not the individual chips: the landing index comes
 * from the pointer's X position against the chips' midpoints, so a drop
 * anywhere along the row lands where it looks like it will. (Per-chip onDrop
 * only fires when you release exactly on top of another chip, which makes the
 * gaps and the trailing empty slots dead zones.)
 *
 * Props:
 *   doc            — { presets: [slot1, slot2, slot3], sequence: [n,n,n], priority: n|null }
 *                    `presets` is indexed by SLOT (a preset's fixed home);
 *                    `sequence` is the left-to-right display order of slots.
 *   currentFilters — the filter object a new preset would capture
 *   onApply        — (filters) => void, fired when a chip is clicked
 *   onChange       — (nextDoc) => void, fired on save / delete / reorder
 *   saving         — disables the controls while a PUT is in flight
 */
import { useRef, useState } from 'react';
import { IconPlus, IconClose, IconCheck } from './icons.jsx';
// Ordering rules live in a plain-JS sibling so node:test can cover them
// directly (same split as clientFilters.js) — see presetOrder.js for why the
// packing matters.
import { SLOTS, normalise, reorder } from './presetOrder.js';

export default function PresetBar({ doc, currentFilters, onApply, onChange, saving = false }) {
  const [namingSlot, setNamingSlot] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [dragFrom, setDragFrom] = useState(null); // display index being dragged
  const [dropAt, setDropAt] = useState(null);     // display index it would land at
  const barRef = useRef(null);

  const sequence = doc.sequence && doc.sequence.length === 3 ? doc.sequence : SLOTS;
  const firstEmptySlot = sequence.find((n) => !doc.presets[n - 1]) ?? null;

  const emit = (presets, seq) => onChange(normalise(presets, seq));

  const saveNew = () => {
    const name = draftName.trim();
    if (!name || namingSlot === null) return;
    const presets = [...doc.presets];
    presets[namingSlot - 1] = { name, filters: currentFilters };
    emit(presets, sequence);
    setNamingSlot(null);
    setDraftName('');
  };

  const remove = (slot) => {
    const presets = [...doc.presets];
    presets[slot - 1] = null;
    // normalise() re-packs and hands priority to the next preset in line.
    emit(presets, sequence);
  };

  /**
   * Landing index from the pointer's X alone. Walks the rendered slots and
   * returns the first whose horizontal midpoint the pointer hasn't passed —
   * i.e. "insert before this one". Past every midpoint means append.
   */
  const indexFromX = (clientX) => {
    const row = barRef.current;
    if (!row) return null;
    const slots = [...row.querySelectorAll('[data-slot]')];
    for (let i = 0; i < slots.length; i += 1) {
      const r = slots[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return slots.length;
  };

  const commitDrop = (to) => {
    const from = dragFrom;
    setDragFrom(null);
    setDropAt(null);
    if (from === null || to === null) return;
    const seq = reorder(sequence, from, to);
    if (seq.every((n, i) => n === sequence[i])) return; // no-op drop
    emit(doc.presets, seq);
  };

  return (
    <div
      className="preset-bar"
      ref={barRef}
      onDragOver={(e) => {
        if (dragFrom === null) return;
        e.preventDefault(); // without this the row refuses the drop entirely
        setDropAt(indexFromX(e.clientX));
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves the row — dragging across
        // a child fires dragleave for the child too.
        if (!barRef.current?.contains(e.relatedTarget)) setDropAt(null);
      }}
      onDrop={(e) => { e.preventDefault(); commitDrop(indexFromX(e.clientX)); }}
    >
      {sequence.map((slot, idx) => {
        const p = doc.presets[slot - 1];
        const isPriority = doc.priority === slot;
        // Insertion marker: before this chip, or after the last one.
        const marker = dragFrom !== null && dropAt !== null
          ? (dropAt === idx ? ' preset-drop-before'
            : (dropAt === sequence.length && idx === sequence.length - 1 ? ' preset-drop-after' : ''))
          : '';

        if (namingSlot === slot) {
          return (
            <form
              key={slot}
              data-slot={slot}
              className="preset-chip preset-chip-naming"
              onSubmit={(e) => { e.preventDefault(); saveNew(); }}
            >
              <input
                autoFocus
                value={draftName}
                maxLength={40}
                placeholder="Preset name"
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setNamingSlot(null); }}
              />
              <button type="submit" className="preset-icon-btn" aria-label="Save preset" disabled={!draftName.trim()}>
                <IconCheck size={13} />
              </button>
            </form>
          );
        }

        if (!p) {
          // Empty slots always trail the occupied ones (normalise), so the
          // "+ Save preset" affordance never sits left of a real preset.
          if (slot !== firstEmptySlot) {
            return <div key={slot} data-slot={slot} className={`preset-chip preset-chip-blank${marker}`} />;
          }
          return (
            <button
              key={slot}
              data-slot={slot}
              type="button"
              className={`preset-chip preset-chip-add${marker}`}
              disabled={saving}
              onClick={() => { setDraftName(''); setNamingSlot(slot); }}
              title="Save the filters below as a preset"
            >
              <IconPlus size={12} /> Save preset
            </button>
          );
        }

        return (
          <div
            key={slot}
            data-slot={slot}
            className={`preset-chip${isPriority ? ' preset-chip-priority' : ''}${dragFrom === idx ? ' preset-chip-dragging' : ''}${marker}`}
            draggable={!saving}
            onDragStart={(e) => {
              setDragFrom(idx);
              // Firefox won't start a drag without payload; also sets the cursor.
              e.dataTransfer.effectAllowed = 'move';
              try { e.dataTransfer.setData('text/plain', String(slot)); } catch { /* IE-ism, ignore */ }
            }}
            onDragEnd={() => { setDragFrom(null); setDropAt(null); }}
            title={isPriority
              ? `"${p.name}" is your priority preset — applied automatically when you open Submissions. Drag another preset to the far left to change that.`
              : `Apply "${p.name}". Drag it to the far left to make it your priority preset.`}
          >
            <button type="button" className="preset-chip-apply" onClick={() => onApply(p.filters)} disabled={saving}>
              {isPriority && <span className="preset-star" aria-label="Priority preset">★</span>}
              {p.name}
            </button>
            <button
              type="button"
              className="preset-icon-btn"
              onClick={() => remove(slot)}
              disabled={saving}
              aria-label={`Delete preset ${p.name}`}
            >
              <IconClose size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
