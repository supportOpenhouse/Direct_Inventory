import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Multiselect with a type-to-filter box and selected-chips. Built for long
 * lists (hundreds/thousands of societies) — the rendered list is capped, the
 * search narrows it.
 */
export default function SearchableMultiSelect({
  options, value, onChange, placeholder = 'Select…', disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const CAP = 200;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    return list.slice(0, CAP);
  }, [options, query]);

  function toggle(opt) {
    if (value.includes(opt)) onChange(value.filter((v) => v !== opt));
    else onChange([...value, opt]);
  }

  const label = value.length === 0 ? placeholder : `${value.length} selected`;

  return (
    <div className={`sms ${disabled ? 'sms-disabled' : ''}`} ref={ref}>
      <button
        type="button"
        className="sms-btn"
        disabled={disabled}
        onClick={() => setOpen((s) => !s)}
      >
        <span className={value.length ? '' : 'sms-placeholder'}>{label}</span>
        <span className="sms-caret">▾</span>
      </button>

      {open && !disabled && (
        <div className="sms-menu">
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
        </div>
      )}

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
