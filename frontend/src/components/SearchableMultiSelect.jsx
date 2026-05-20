import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Multiselect with a type-to-filter box and selected-chips. Built for long
 * lists (hundreds/thousands of societies).
 *
 * The popup is rendered in a portal with fixed positioning so it is never
 * clipped by the narrow grid column it lives in. It always opens downward;
 * its height is capped to the space available below so it stays on-screen.
 * (The host modal is pinned near the top of the viewport to leave room.)
 */
const MENU_MIN_WIDTH = 380;   // px — wide enough for long society names
const LIST_CAP = 200;         // max rows rendered at once

export default function SearchableMultiSelect({
  options, value, onChange, placeholder = 'Select…', disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState(null);   // { left, top?, bottom?, width }
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const computePos = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const width = Math.min(Math.max(r.width, MENU_MIN_WIDTH), vw - 16);
    let left = r.left;
    if (left + width > vw - 8) left = Math.max(8, vw - 8 - width);

    // Always open downward; cap the height to whatever room is below the
    // button so the popup never runs off the bottom of the screen.
    const top = r.bottom + 4;
    const maxHeight = Math.max(180, vh - top - 12);

    setPos({ left, width, top, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    computePos();
    const onMove = () => computePos();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, computePos]);

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (btnRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    return list.slice(0, LIST_CAP);
  }, [options, query]);

  function toggle(opt) {
    if (value.includes(opt)) onChange(value.filter((v) => v !== opt));
    else onChange([...value, opt]);
  }

  const label = value.length === 0 ? placeholder : `${value.length} selected`;

  const menu = open && !disabled && pos
    ? createPortal(
        <div
          ref={menuRef}
          className="sms-menu"
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.top,
            width: pos.width,
            maxHeight: pos.maxHeight,
          }}
        >
          <input
            className="sms-search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {value.length > 0 && (
            <button type="button" className="sms-clear" onClick={() => onChange([])}>
              Clear {value.length} selected
            </button>
          )}
          <div className="sms-list">
            {filtered.length === 0 && <div className="sms-empty">No matches.</div>}
            {filtered.map((opt) => (
              <label key={opt} className="sms-item">
                <input
                  type="checkbox"
                  checked={value.includes(opt)}
                  onChange={() => toggle(opt)}
                />
                <span>{opt}</span>
              </label>
            ))}
            {!query && options.length > filtered.length && (
              <div className="sms-more">
                Showing first {filtered.length} of {options.length} — type to search.
              </div>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className={`sms ${disabled ? 'sms-disabled' : ''}`}>
      <button
        type="button"
        ref={btnRef}
        className="sms-btn"
        disabled={disabled}
        onClick={() => setOpen((s) => !s)}
      >
        <span className={value.length ? '' : 'sms-placeholder'}>{label}</span>
        <span className="sms-caret">▾</span>
      </button>

      {menu}

      {value.length > 0 && (
        <div className="sms-chips">
          {value.map((v) => (
            <span key={v} className="sms-chip">
              {v}
              {!disabled && (
                <button type="button" onClick={() => toggle(v)} aria-label={`Remove ${v}`}>×</button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
