export function formatPrice(p) {
  if (p == null) return '—';
  const n = Number(p);
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2)} Cr`;
  if (n >= 1_00_000)    return `₹${(n / 1_00_000).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
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
    qualified: 'Qualified',
    follow_up_cnr: 'Follow Up (CNR)',
    visit_scheduled: 'Visit Scheduled',
    visit_completed: 'Visit Completed',
    offer_given: 'Offer Given',
    unreachable: 'Unreachable',
    rejected: 'Rejected',
  })[s] || s;
}

export const STAGES = [
  'qualified',
  'follow_up_cnr',
  'visit_scheduled',
  'visit_completed',
  'offer_given',
  'unreachable',
  'rejected',
];

export const STAGE_DOT_COLOR = {
  qualified: '#a78bfa',
  follow_up_cnr: '#facc15',
  visit_scheduled: '#a855f7',
  visit_completed: '#22c55e',
  offer_given: '#fb923c',
  unreachable: '#94a3b8',
  rejected: '#ef4444',
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
