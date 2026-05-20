// Local "today" as YYYY-MM-DD (good for <input type="date" min={...}>).
// Using local date (not UTC) so users in IST don't see the wrong floor
// in the early-morning hours.
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatPrice(p) {
  if (p == null) return '—';
  const n = Number(p);
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2)} Cr`;
  if (n >= 1_00_000)    return `₹${(n / 1_00_000).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

// Format a date as "DD MMM YYYY" with a 3-letter month. Accepts either
// RFC 2822 ("Thu, 14 May 2026 00:00:00 GMT", what Flask jsonifies datetimes to)
// or YYYY-MM-DD. DATE columns serialize to UTC midnight, so we read UTC parts
// to avoid the value drifting a day in IST.
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function formatDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// True when a row is in the Follow Up stage AND its follow-up date is strictly
// before today — i.e. an overdue follow-up. Today and future dates → false.
// The stored value is UTC midnight of the date, so UTC parts give the date;
// it's compared against the local (IST) today as YYYY-MM-DD strings.
export function isFollowUpOverdue(item) {
  if (!item || item.stage !== 'follow_up' || !item.follow_up_at) return false;
  const d = new Date(item.follow_up_at);
  if (Number.isNaN(d.getTime())) return false;
  const fu = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return fu < todayISO();
}

export function formatDateRel(iso) {
  if (!iso) return '—';
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function stageLabel(s) {
  return ({
    qualified: 'Lead',
    call_not_received: 'Call Not Received',
    follow_up: 'Follow Up',
    visit_scheduled: 'Visit Scheduled',
    rejected: 'Rejected',
    // Legacy stage labels — kept so historical activity-log entries and any
    // rows still sitting in these stages render with the right name.
    follow_up_cnr: 'Follow Up (CNR)',
    visit_completed: 'Visit Completed',
    offer_given: 'Offer Given',
    unreachable: 'Unreachable',
  })[s] || s;
}

// Board-visible stages, in display order. Drives kanban columns, count pills,
// and the stage dropdown on the card detail modal.
export const STAGES = [
  'qualified',
  'call_not_received',
  'follow_up',
  'visit_scheduled',
  'rejected',
];

export const STAGE_DOT_COLOR = {
  qualified: '#a78bfa',
  call_not_received: '#facc15',
  follow_up: '#f97316',
  visit_scheduled: '#a855f7',
  rejected: '#ef4444',
  // Legacy stages — used by stage-dot rendering on any stray rows.
  follow_up_cnr: '#facc15',
  visit_completed: '#22c55e',
  offer_given: '#fb923c',
  unreachable: '#94a3b8',
};

export const REJECT_REASONS = [
  { value: 'not_interested',   label: 'Not Interested' },
  { value: 'invalid_duplicate', label: 'Invalid / Duplicate' },
  { value: 'future_prospect',  label: 'Future Prospect' },
  { value: 'oh_rejected',      label: 'OH Rejected' },
  { value: 'sold',             label: 'Sold' },
  { value: 'broker_listing',   label: 'Broker Listing' },
];

// Greater Noida is rolled up into Noida everywhere in the UI.
// Order matters: this is the order shown in city tabs and dropdowns.
export const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];

export function displayCity(city) {
  if (!city) return '';
  if (city === 'Greater Noida') return 'Noida';
  return city;
}

// Sources that mean "added through our UI" rather than crawled from a listing site.
// Cards with these sources get an orange visual treatment.
export const MANUAL_SOURCES = new Set(['Website', 'manual']);
export function isManualSource(src) {
  if (!src) return false;
  return MANUAL_SOURCES.has(src);
}

// Resolves the star color that should be rendered for a row.
// Manual override (item.star_color) wins; otherwise fall back to the
// existing rules — priority -> yellow, cp_match -> green/red, else null.
// Returns one of 'yellow' | 'green' | 'red' | null.
//   star_color === 'none'  -> manual blank (suppress default rules)
//   star_color === null    -> no override, apply default rules
export function starColor(item) {
  if (!item) return null;
  const sc = item.star_color;
  if (sc === 'red' || sc === 'green' || sc === 'yellow') return sc;
  if (sc === 'none') return null;
  if (item.priority) return 'yellow';
  if (item.cp_match === 'perfect') return 'green';
  if (item.cp_match === 'partial') return 'red';
  return null;
}

// Variation = (asking - oh_price) / oh_price * 100, signed.
// Returns { pct, label, sign } or null if either side is missing/zero.
//   sign === 'pos' means asking is OVER OH (typically less attractive)
//   sign === 'neg' means asking is UNDER OH (typically more attractive)
//   sign === 'flat' for |pct| < 0.5
export function variation(asking, oh) {
  const a = Number(asking);
  const o = Number(oh);
  if (!Number.isFinite(a) || !Number.isFinite(o) || o === 0) return null;
  const pct = ((a - o) / o) * 100;
  const sign = Math.abs(pct) < 0.5 ? 'flat' : (pct > 0 ? 'pos' : 'neg');
  const label = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  return { pct, label, sign };
}
