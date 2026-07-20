import { useCallback, useEffect, useRef, useState } from 'react';

// Must match the exit animation in styles.css (.modal-backdrop-closing).
const EXIT_MS = 240;

// Only the TOPMOST modal reacts to Escape — otherwise a stacked pair (e.g. the
// report day-modal with a property popup over it) would both close at once.
const stack = [];

const instant = () => typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Gives a modal an animated close + Escape-to-close.
 *
 * Use it by SHADOWING the raw prop, so every existing `onClose` call inside the
 * component (Cancel button, ✕, save-then-close) animates without being touched:
 *
 *   export default function FooModal({ onClose: rawClose }) {
 *     const { onClose, backdropClass } = useModalExit(rawClose);
 *     return <div className={backdropClass} onClick={onClose}> … </div>;
 *   }
 *
 * The real `rawClose` (which unmounts us) fires only after the exit animation,
 * so the element is still mounted while it plays.
 */
export function useModalExit(rawClose) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const timerRef = useRef(null);

  const onClose = useCallback(() => {
    if (closingRef.current) return;      // ignore repeat presses mid-exit
    closingRef.current = true;
    setClosing(true);
    timerRef.current = setTimeout(rawClose, instant() ? 0 : EXIT_MS);
  }, [rawClose]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  useEffect(() => {
    const token = {};
    stack.push(token);
    function onKey(e) {
      if (e.key !== 'Escape') return;
      if (stack[stack.length - 1] !== token) return;   // not the top modal
      e.stopPropagation();
      onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [onClose]);

  return { onClose, closing, backdropClass: `modal-backdrop${closing ? ' modal-backdrop-closing' : ''}` };
}
