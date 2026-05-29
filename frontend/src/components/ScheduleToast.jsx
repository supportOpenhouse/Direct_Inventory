// Right-side slide-in toast used by the visit-scheduled flow to surface
// missing-field / Forms-rejection / exec-unavailable errors without burying
// them inside the modal body. Persistent until dismissed.

// Forms-side field names → human-readable labels. Mirrors the payload built
// in backend/api/visits.py::schedule_visit and the column names in inventory.
// Update both sides together if Forms changes its schema.
export const FIELD_LABELS = {
  // Forms canonical names (what the Forms app returns in `missing`)
  first_name: 'Seller name',
  contact_no: 'Seller phone',
  area_sqft: 'Area (sqft)',
  society_name: 'Society',
  locality: 'Locality',
  configuration: 'Configuration (BHK)',
  unit_no: 'Unit no.',
  tower_no: 'Tower',
  floor: 'Floor',
  demand_price: 'Asking price',
  city: 'City',
  assigned_by: 'Assigned by',
  field_exec: 'Field exec',
  schedule_date: 'Date',
  schedule_time: 'Time',
  // Direct-side aliases (what we use client-side for pre-validation)
  seller_name: 'Seller name',
  seller_phone: 'Seller phone',
  tower: 'Tower',
  bedrooms: 'BHK',
  society: 'Society',
};

export function labelFor(field) {
  return FIELD_LABELS[field] || field;
}

// Inspect the inventory row and return the list of Forms-name fields that
// would cause the schedule call to fail. Kept in sync with what visits.py
// sends and what the user marked as required.
export function collectMissingLeadFields(item) {
  const missing = [];
  if (!item.seller_name || !String(item.seller_name).trim()) missing.push('first_name');
  // Forms wants a 10-digit phone; treat anything shorter as missing.
  const phone = String(item.seller_phone || '').replace(/\D/g, '');
  if (phone.length < 10) missing.push('contact_no');
  if (item.area_sqft == null || Number(item.area_sqft) <= 0) missing.push('area_sqft');
  if (!item.tower || !String(item.tower).trim()) missing.push('tower_no');
  if (!item.unit_no || !String(item.unit_no).trim()) missing.push('unit_no');
  if (item.floor == null || String(item.floor).trim() === '') missing.push('floor');
  return missing;
}

export default function ScheduleToast({ toast, onClose }) {
  if (!toast) return null;
  return (
    <div className="di-toast-wrap">
      <div className={`di-toast di-toast-${toast.kind || 'error'}`} role="alert">
        <button
          type="button"
          className="di-toast-close"
          onClick={onClose}
          aria-label="Dismiss"
        >×</button>
        <div className="di-toast-title">{toast.title}</div>
        {toast.message && <div className="di-toast-body">{toast.message}</div>}
        {Array.isArray(toast.lines) && toast.lines.length > 0 && (
          <ul className="di-toast-list">
            {toast.lines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
