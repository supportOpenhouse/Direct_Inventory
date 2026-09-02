import { useEffect } from 'react';

// Fires `handler` when a pointer/touch event lands outside `ref`. Converted to
// plain JS (from serafimcloud/use-click-outside).
export function useClickOutside(ref, handler, mouseEvent = 'mousedown') {
  useEffect(() => {
    const listener = (event) => {
      const el = ref?.current;
      const target = event.target;
      // Do nothing if clicking ref's element or its descendants.
      if (!el || !target || el.contains(target)) return;
      handler(event);
    };
    document.addEventListener(mouseEvent, listener);
    document.addEventListener('touchstart', listener);
    return () => {
      document.removeEventListener(mouseEvent, listener);
      document.removeEventListener('touchstart', listener);
    };
  }, [ref, handler, mouseEvent]);
}
