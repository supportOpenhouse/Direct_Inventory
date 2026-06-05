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

// A DATE column (follow_up_at) serializes to UTC midnight, so reading UTC
// parts gives its calendar date. True when that date is strictly before the
// local (IST) today; compared as YYYY-MM-DD strings.
function isDateBeforeToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return day < todayISO();
}

// Whole days between `iso` and now, floored. 0 means within the last 24h —
// exactly when formatDateRel() labels it "Today". null on an unparseable date.
function daysAgo(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((Date.now() - then.getTime()) / 86400_000);
}

// Attention flag for a row's OH-ID / City / Society cells. Returns one of:
//   'yellow' — Follow Up stage and the follow-up date has already passed.
//   'red'    — Lead stage that came in before today (a stale,
//              unworked lead). Driven by created_at via the same day-count as
//              the "Posted" column, so a row showing "Posted: Today" is never
//              red.
//   null     — neither.
// The two stages are disjoint, so the rules never conflict.
export function rowFlag(item) {
  if (!item) return null;
  if (item.stage === 'follow_up' && isDateBeforeToday(item.follow_up_at)) return 'yellow';
  if (item.stage === 'lead') {
    const d = daysAgo(item.created_at);
    if (d != null && d >= 1) return 'red';
  }
  return null;
}

export function formatDateRel(iso) {
  if (!iso) return '—';
  const days = daysAgo(iso);
  if (days == null) return String(iso);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function stageLabel(s) {
  return ({
    lead: 'Lead',
    call_not_received: 'Call Not Received',
    follow_up: 'Follow Up',
    visit_scheduled: 'Visit Scheduled',
    rejected: 'Rejected',
    // Legacy stage labels — kept so historical activity-log entries and any
    // rows still sitting in these stages render with the right name.
    qualified: 'Lead',          // renamed to 'lead'; kept for pre-migration rows
    follow_up_cnr: 'Follow Up (CNR)',
    visit_completed: 'Visit Completed',
    offer_given: 'Offer Given',
    unreachable: 'Unreachable',
  })[s] || s;
}

// Board-visible stages, in display order. Drives kanban columns, count pills,
// and the stage dropdown on the card detail modal.
export const STAGES = [
  'lead',
  'call_not_received',
  'follow_up',
  'visit_scheduled',
  'rejected',
];

export const STAGE_DOT_COLOR = {
  lead: '#a78bfa',
  call_not_received: '#facc15',
  follow_up: '#f97316',
  visit_scheduled: '#a855f7',
  rejected: '#ef4444',
  // Legacy stages — used by stage-dot rendering on any stray rows.
  qualified: '#a78bfa',         // renamed to 'lead'; kept for pre-migration rows
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

// OH-price match presentation. A row either has a strict price (society + BHK +
// area within ±50 sqft) or it shows "Check Price" with a reason. Returns
// { sub, title } — `sub` is the small grey label under "Check Price" (empty when
// matched), `title` is the cell hover tooltip for both states.
export function ohMatchInfo(item) {
  if (item.oh_price) {
    const a = Number(item.area_sqft);
    const oa = Number(item.oh_price_area);
    const diff = (Number.isFinite(a) && Number.isFinite(oa)) ? Math.abs(oa - a) : null;
    const title = `Matched ${item.oh_price_bhk}BHK ${item.oh_price_area}sqft`
      + (diff != null ? ` (±${diff} sqft)` : '');
    return { sub: '', title };
  }
  switch (item.oh_price_reason) {
    case 'area_off':
      return {
        sub: 'area off',
        title: item.oh_near_diff != null
          ? `Nearest priced area is ${item.oh_near_diff} sqft off (>50) — open card to verify`
          : 'Nearest priced area is >50 sqft off — open card to verify',
      };
    case 'no_area':
      return { sub: 'no area', title: 'Listing has no area, so it can’t be area-matched' };
    case 'no_match':
    default:
      return { sub: 'no match', title: 'No OH price for this society + BHK' };
  }
}
