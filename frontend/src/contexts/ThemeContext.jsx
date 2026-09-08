import { createContext, useContext, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

const ThemeContext = createContext(null);
const KEY = 'di_theme';
const WIPES = ['ltr', 'rtl', 'ttb', 'btt'];

function initialTheme() {
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  // Default to light regardless of the OS preference; a user's explicit
  // toggle is still remembered via localStorage.
  return 'light';
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  // Curtain wipe on theme change, via the native View Transitions API — the
  // direction is drawn fresh each toggle (see "theme wipe" in styles.css).
  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    const root = document.documentElement;
    if (!document.startViewTransition) { setTheme(next); return; }
    root.dataset.wipe = WIPES[Math.floor(Math.random() * WIPES.length)];
    const vt = document.startViewTransition(() => {
      // flushSync so the re-render lands before the "new" snapshot is taken;
      // the attribute is set here too because the effect above is passive and
      // would otherwise fire after the snapshot.
      flushSync(() => setTheme(next));
      root.setAttribute('data-theme', next);
    });
    vt.finished.finally(() => { delete root.dataset.wipe; });
  }

  return (
    <ThemeContext.Provider value={{ theme, toggle, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
