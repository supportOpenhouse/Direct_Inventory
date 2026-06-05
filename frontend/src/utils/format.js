// Local "today" as YYYY-MM-DD (good for <input type="date" min={...}>).
// Local date (not UTC) so IST users don't see the wrong floor in the early hours.
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatPrice(p) {
  if (p == null) return '—';
  const n = Number(p);
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2)} Cr`;
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

// "DD MMM YYYY" with a 3-letter month. Accepts RFC-2822 (what Flask jsonifies
// datetimes to) or YYYY-MM-DD. DATE columns serialize to UTC midnight, so read
// UTC parts to avoid drifting a day in IST.
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// A DATE column (follow_up_at) serializes to UTC midnight; reading UTC parts
// gives its calendar date. As a YYYY-MM-DD string for cheap comparisons.
export function dateOnly(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function isDateBeforeToday(iso) {
  const day = dateOnly(iso);
  return day != null && day < todayISO();
}
export function isDateToday(iso) {
  return dateOnly(iso) === todayISO();
}
export function isDateAfterToday(iso) {
  const day = dateOnly(iso);
  return day != null && day > todayISO();
}

// Whole days between `iso` and now, floored. 0 = within the last 24h.
function daysAgo(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((Date.now() - then.getTime()) / 86400_000);
}

// True when created_at is on today's local calendar date — drives the "NEW"
// badge on the Leads board.
export function isCreatedToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return local === todayISO();
}

// Attention flag for a row's identity cells. See InventoryTable.
export function rowFlag(item) {
  if (!item) return null;
  if (item.stage === 'follow_up' && isDateBeforeToday(item.follow_up_at)) return 'yellow';
  if (item.stage === 'lead' || item.stage === 'unqualified' || item.stage === 'active') {
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
    active: 'Active Lead',
    qualified: 'Qualified',
    call_not_received: 'Call Not Received',
    follow_up: 'Follow Up',
    visit_scheduled: 'Visit Scheduled',
    rejected: 'Rejected',
    // Supply Closure Tracker stages (post-visit acquisition funnel).
    pipeline: 'Pipeline',
    token_to_ama: 'Token to AMA',
    onboarded: 'Onboarded',
    rejected_post_visit: 'Rejected Post Visit',
    cancelled_post_token: 'Cancelled Post Token',
    // Legacy — historical rows still render.
    unqualified: 'Lead',
    follow_up_cnr: 'Follow Up (CNR)',
    visit_completed: 'Visit Completed',
    offer_given: 'Offer Given',
    unreachable: 'Unreachable',
  })[s] || s;
}

// Board-visible stages, in display + flow order. Drives count pills, stage
// dropdowns and analytics order.
//   lead -> active -> qualified -> {call_not_received, follow_up,
//                                   visit_scheduled, rejected}
export const STAGES = [
  'lead',
  'active',
  'qualified',
  'call_not_received',
  'follow_up',
  'visit_scheduled',
  'rejected',
];

export const STAGE_DOT_COLOR = {
  lead: '#fa541c',
  active: '#f59e0b',
  unqualified: '#fa541c',
  qualified: '#16a34a',
  call_not_received: '#facc15',
  follow_up: '#f97316',
  visit_scheduled: '#a855f7',
  rejected: '#ef4444',
  // Supply Closure Tracker stages
  pipeline: '#0ea5e9',
  token_to_ama: '#8b5cf6',
  onboarded: '#16a34a',
  rejected_post_visit: '#ef4444',
  cancelled_post_token: '#64748b',
  // Legacy
  lead: '#fa541c',
  follow_up_cnr: '#facc15',
  visit_completed: '#22c55e',
  offer_given: '#fb923c',
  unreachable: '#94a3b8',
};

// ── Supply Closure Tracker (post-visit acquisition funnel) ───────────────────
// Synced from PROPERTIES_DB.cp_inventory_status: direct_stage → inventory.stage,
// supply_status → inventory.stage_reason (both slugified, e.g. "Token to AMA"
// → "token_to_ama"). These stages live alongside the lead stages.
export const SUPPLY_STAGES = ['pipeline', 'token_to_ama', 'onboarded', 'rejected_post_visit', 'cancelled_post_token'];

export const SUPPLY_STAGE_REASONS = {
  pipeline: [
    { value: 'visit_completed', label: 'Visit Completed' },
    { value: 'followup', label: 'Followup' },
    { value: 'negotiation', label: 'Negotiation' },
    { value: 'hold', label: 'Hold' },
    { value: 'future_prospect', label: 'Future Prospect' },
  ],
  token_to_ama: [
    { value: 'token_requested', label: 'Token Requested' },
    { value: 'token_transferred', label: 'Token Transferred' },
    { value: 'ama_req', label: 'AMA Req' },
    { value: 'ama_signed', label: 'AMA Signed' },
  ],
  onboarded: [
    { value: 'key_handover', label: 'Key Handover' },
    { value: 'listed', label: 'Listed' },
  ],
  rejected_post_visit: [
    { value: 'duplicacy', label: 'Duplicacy' },
    { value: 'dead_sold', label: 'Dead - Sold' },
    { value: 'oh_rejected', label: 'OH Rejected' },
    { value: 'dead_not_interested', label: 'Dead - Not Interested' },
    { value: 'seller_rejected', label: 'Seller Rejected' },
    { value: 'dead_legal', label: 'Dead - Legal' },
  ],
  cancelled_post_token: [
    { value: 'cancelled_post_token', label: 'Cancelled Post Token' },
  ],
};

export const ALL_SUPPLY_REASONS = Object.values(SUPPLY_STAGE_REASONS).flat();

export function supplyReasonLabel(code) {
  if (!code) return '';
  return ALL_SUPPLY_REASONS.find((r) => r.value === code)?.label
    || code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Reject reasons come in two context sets, both written to
// inventory.stage_reason alongside stage='rejected':
//   - UNQUALIFIED_REJECT_REASONS — shown when rejecting an unqualified/intake
//     lead (listing-quality reasons).
//   - REJECT_REASONS — shown when rejecting from a worked stage (qualified /
//     call_not_received / follow_up / visit_scheduled). These are the
//     engagement reasons already present in the live DB.
// A duplicate listing uses the SAME `invalid_duplicate` value in both contexts
// (the older intake-only `duplicate` value was folded into it) so it lands in a
// single category in breakdowns/reports.
export const UNQUALIFIED_REJECT_REASONS = [
  { value: 'ground_floor', label: 'Ground Floor' },
  { value: 'listing_removed', label: 'Listing Removed' },
  { value: 'invalid_duplicate', label: 'Invalid / Duplicate' },
];

export const REJECT_REASONS = [
  { value: 'not_interested', label: 'Not Interested' },
  { value: 'invalid_duplicate', label: 'Invalid / Duplicate' },
  { value: 'future_prospect', label: 'Future Prospect' },
  { value: 'oh_rejected', label: 'OH Rejected' },
  { value: 'sold', label: 'Sold' },
  { value: 'broker_listing', label: 'Broker Listing' },
];

// Active-lead rejects — contact-quality reasons shown when rejecting from the
// 'active' stage (after the lead has been picked up but the seller couldn't be
// reached / the number was bad).
export const ACTIVE_REJECT_REASONS = [
  { value: 'number_not_found', label: 'No. not found' },
  { value: 'invalid_number', label: 'Invalid No.' },
];

// Every reject reason across all contexts, de-duplicated by value (the contexts
// share `invalid_duplicate`) — for breakdowns / labels that need to cover
// whatever value a row actually carries.
export const ALL_REJECT_REASONS = [...UNQUALIFIED_REJECT_REASONS, ...REJECT_REASONS, ...ACTIVE_REJECT_REASONS]
  .filter((r, i, arr) => arr.findIndex((x) => x.value === r.value) === i);

// Pick the reason list for the lead's CURRENT stage: an unqualified/intake lead
// uses the listing-quality reasons; an active lead uses the contact-quality
// reasons; anything already worked uses the rest.
export function rejectReasonsForStage(stage) {
  if (stage === 'lead' || stage === 'unqualified') return UNQUALIFIED_REJECT_REASONS;
  if (stage === 'active') return ACTIVE_REJECT_REASONS;
  return REJECT_REASONS;
}

export function rejectReasonLabel(code) {
  if (!code) return '';
  return ALL_REJECT_REASONS.find((r) => r.value === code)?.label || code;
}

// Label for any stage_reason regardless of which stage it belongs to — reject
// reasons OR supply-tracker reasons — falling back to a title-cased code.
export function reasonLabelAny(code) {
  if (!code) return '';
  return ALL_REJECT_REASONS.find((r) => r.value === code)?.label
    || ALL_SUPPLY_REASONS.find((r) => r.value === code)?.label
    || code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Greater Noida is rolled up into Noida everywhere in the UI.
export const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];
export function displayCity(city) {
  if (!city) return '';
  if (city === 'Greater Noida') return 'Noida';
  return city;
}

// Roll any 'Greater Noida' into 'Noida' across a list of city names and dedupe,
// so 'Greater Noida' is never offered or stored as a separate city.
export function foldCities(list) {
  return [...new Set((list || []).map(displayCity).filter(Boolean))];
}

export const MANUAL_SOURCES = new Set(['Website', 'manual']);
export function isManualSource(src) {
  if (!src) return false;
  return MANUAL_SOURCES.has(src);
}

// Star color rendered for a row. Manual override (star_color) wins; otherwise
// priority -> yellow, cp_match -> green/red, else null.
//   star_color === 'none' -> manual blank (suppress default rules)
//   star_color === null   -> no override, apply defaults
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
// sign 'pos' = asking OVER OH; 'neg' = UNDER OH; 'flat' for |pct| < 0.5.
export function variation(asking, oh) {
  const a = Number(asking);
  const o = Number(oh);
  if (!Number.isFinite(a) || !Number.isFinite(o) || o === 0) return null;
  const pct = ((a - o) / o) * 100;
  const sign = Math.abs(pct) < 0.5 ? 'flat' : (pct > 0 ? 'pos' : 'neg');
  const label = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  return { pct, label, sign };
}

// OH Price cell state — single source of truth for what the price cell shows.
// A real match shows the green price; otherwise "Check Price" with a reason
// sub-text + tooltip. Driven by the backend's oh_price / oh_price_reason /
// oh_near_diff (a strict society + exact BHK + area ±50 lookup; never a guess).
export function ohMatchInfo(item) {
  if (item.oh_price != null) {
    const bhk = item.oh_price_bhk;
    const area = item.oh_price_area;
    const diff = (area != null && item.area_sqft != null) ? Math.abs(area - item.area_sqft) : null;
    const parts = [
      bhk != null ? `${bhk}BHK` : null,
      area != null ? `${area}sqft` : null,
    ].filter(Boolean).join(' ');
    const title = `Matched${parts ? ` ${parts}` : ''}${diff != null ? ` (±${diff} sqft)` : ''}`;
    return { matched: true, sub: null, title };
  }
  switch (item.oh_price_reason) {
    case 'area_off': {
      const n = item.oh_near_diff;
      return {
        matched: false, sub: 'area off',
        title: n != null
          ? `Nearest priced area is ${n} sqft off (>50) — open card to verify`
          : 'Nearest priced area is >50 sqft off — open card to verify',
      };
    }
    case 'no_area':
      return { matched: false, sub: 'no area', title: "Listing has no area, so it can't be area-matched" };
    default: // 'no_match' (or missing)
      return { matched: false, sub: 'no match', title: 'No OH price for this society + BHK' };
  }
}
