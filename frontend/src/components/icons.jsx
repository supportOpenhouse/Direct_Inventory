// Lightweight inline stroke icons. One component per glyph, 1.6px stroke,
// inherits currentColor. Keeps the bundle dependency-free.
const S = ({ children, size = 18, fill = 'none' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}
       stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export const IconHome = (p) => <S {...p}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" /></S>;
// Siren / beacon — alert vibe (🚨) in the same stroke style as the set.
export const IconLeads = (p) => <S {...p}><path d="M5 18h14" /><path d="M7 18a5 5 0 0 1 10 0" /><path d="M12 13V9" /><path d="M12 9 9.5 6M12 9l2.5-3" /></S>;
export const IconFollowUp = (p) => <S {...p}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /><path d="m9 16 2 2 4-4" /></S>;
export const IconVisit = (p) => <S {...p}><path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10Z" /><circle cx="12" cy="11" r="2" /></S>;
export const IconQualified = (p) => <S {...p}><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></S>;
// Abacus (🧮) — Supply Closure Tracker.
export const IconPipeline = (p) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14.5h18" /><circle cx="7" cy="6.5" r="1.2" /><circle cx="10.5" cy="6.5" r="1.2" /><circle cx="14" cy="11.75" r="1.2" /><circle cx="17.5" cy="11.75" r="1.2" /><circle cx="7" cy="17.25" r="1.2" /><circle cx="10.5" cy="17.25" r="1.2" /></S>;
export const IconToken = (p) => <S {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9 9.5h4.5a1.5 1.5 0 0 1 0 3H9h5" /></S>;
export const IconRejected = (p) => <S {...p}><circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" /></S>;
export const IconReport = (p) => <S {...p}><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" /><rect x="12" y="7" width="3" height="10" /><rect x="17" y="13" width="3" height="4" /></S>;
export const IconUsers = (p) => <S {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9.5" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /></S>;
export const IconLogs = (p) => <S {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></S>;
export const IconBell = (p) => <S {...p}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></S>;
export const IconSun = (p) => <S {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></S>;
export const IconMoon = (p) => <S {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></S>;
export const IconSearch = (p) => <S {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></S>;
export const IconFilter = (p) => <S {...p}><path d="M3 5h18l-7 8v6l-4 2v-8z" /></S>;
export const IconPlus = (p) => <S {...p}><path d="M12 5v14M5 12h14" /></S>;
export const IconClose = (p) => <S {...p}><path d="M18 6 6 18M6 6l12 12" /></S>;
export const IconReload = (p) => <S {...p}><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></S>;
export const IconExternal = (p) => <S {...p}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></S>;
export const IconChevron = (p) => <S {...p}><path d="m9 18 6-6-6-6" /></S>;
export const IconMenu = (p) => <S {...p}><path d="M3 6h18M3 12h18M3 18h18" /></S>;
export const IconLogout = (p) => <S {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></S>;
export const IconDownload = (p) => <S {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5M12 15V3" /></S>;
export const IconLock = (p) => <S {...p}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></S>;
// Clipboard with a check — task tracking.
export const IconTasks = (p) => <S {...p}><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="m9.5 12.5 1.8 1.8 3.2-3.6" /></S>;
