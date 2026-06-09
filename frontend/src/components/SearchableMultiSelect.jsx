import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const MENU_MIN_WIDTH = 320;
const LIST_CAP = 200;

/**
 * Type-to-filter multiselect with selected chips, rendered in a portal so it
 * is never clipped. `single` mode commits + closes on pick (used for one-of
 * fields like society on Add Inventory).
 */
export default function SearchableMultiSelect({
  options, value, onChange, placeholder = 'Select…', disabled = false, single = false,
}) {
  // Options may be plain strings or { value, label } objects. Normalize to
  // objects internally; `value`/`onChange` always speak in `value`s (the string
  // itself for string options), so existing string usage is unchanged.
  const opts = useMemo(
    () => (options || []).map((o) => (o && typeof o === 'object'
      ? { value: o.value, label: o.label ?? String(o.value) }
      : { value: o, label: String(o) })),
    [options],
  );
  const labelOf = useMemo(() => {
    const m = new Map(opts.map((o) => [o.value, o.label]));
    return (v) => (m.has(v) ? m.get(v) : v);
  }, [opts]);

  const selected = single ? (value || '') : (Array.isArray(value) ? value : []);
  const isSel = (v) => (single ? selected === v : selected.includes(v));
  const selectedCount = single ? (selected ? 1 : 0) : selected.length;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const inputRef = useRef(null);

  const computePos = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, MENU_MIN_WIDTH), vw - 16);
    let left = r.left;
    if (left + width > vw - 8) left = Math.max(8, vw - 8 - width);
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
    return () => { window.removeEventListener('scroll', onMove, true); window.removeEventListener('resize', onMove); };
  }, [open, computePos]);

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (btnRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false); setQuery('');
    }
    function onKey(e) { if (e.key === 'Escape') { setOpen(false); setQuery(''); } }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? opts.filter((o) => o.label.toLowerCase().includes(q)) : opts;
    return list.slice(0, LIST_CAP);
  }, [opts, query]);

  function pick(v) {
    if (single) { onChange(v); setOpen(false); setQuery(''); return; }
    if (selected.includes(v)) onChange(selected.filter((x) => x !== v));
    else onChange([...selected, v]);
  }

  const label = single ? (selected ? labelOf(selected) : placeholder) : (selectedCount === 0 ? placeholder : `${selectedCount} selected`);

  const menu = open && !disabled && pos
    ? createPortal(
        <div ref={menuRef} className="sms-menu" style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}>
          {selectedCount > 0 && (
            <button type="button" className="sms-clear" onClick={() => { onChange(single ? '' : []); if (single) setOpen(false); }}>
              {single ? 'Clear selection' : `Clear ${selectedCount} selected`}
            </button>
          )}
          <div className="sms-list">
            {filtered.length === 0 && <div className="sms-empty">No matches.</div>}
            {filtered.map((opt) => (single ? (
              <button key={opt.value} type="button" className={`sms-item sms-item-single ${isSel(opt.value) ? 'sms-item-selected' : ''}`} onClick={() => pick(opt.value)}>
                <span>{opt.label}</span>
              </button>
            ) : (
              <label key={opt.value} className="sms-item">
                <input type="checkbox" checked={isSel(opt.value)} onChange={() => pick(opt.value)} />
                <span>{opt.label}</span>
              </label>
            )))}
            {!query && opts.length > filtered.length && (
              <div className="sms-more">Showing first {filtered.length} of {opts.length} — type to search.</div>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  function toggle() {
    setOpen((s) => {
      const next = !s;
      if (next) { setTimeout(() => inputRef.current?.focus(), 0); } else { setQuery(''); }
      return next;
    });
  }

  return (
    <div className={`sms ${disabled ? 'sms-disabled' : ''}`}>
      <div ref={btnRef} className="sms-control">
        <input
          ref={inputRef}
          type="text"
          className="sms-input"
          disabled={disabled}
          value={query}
          placeholder={label}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        />
        <span className="sms-caret" role="button" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); if (!disabled) toggle(); }}>▾</span>
      </div>
      {menu}
      {!single && selectedCount > 0 && (
        <div className="sms-chips">
          {selected.map((vv) => (
            <span key={vv} className="sms-chip">{labelOf(vv)}{!disabled && <button type="button" onClick={() => pick(vv)} aria-label={`Remove ${labelOf(vv)}`}>×</button>}</span>
          ))}
        </div>
      )}
    </div>
  );
}
