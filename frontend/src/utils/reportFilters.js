// Date helpers shared between the User Report list and per-user detail pages.
// All boundaries are in IST so they line up with backend dedupe.

const MS_PER_DAY = 86_400_000;

export function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 - now.getTimezoneOffset()) * 60_000);
  return ist.toISOString().slice(0, 10);
}

export function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday-anchored week (Mon..Sun). Returns { from, to } as ISO strings.
function weekRange(refIso) {
  const d = new Date(refIso + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7;   // Mon=0..Sun=6
  const start = new Date(d.getTime() - dow * MS_PER_DAY);
  const end = new Date(start.getTime() + 6 * MS_PER_DAY);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function monthRange(refIso) {
  const d = new Date(refIso + 'T00:00:00');
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return {
    from: first.toISOString().slice(0, 10),
    to: last.toISOString().slice(0, 10),
  };
}

// Named presets — used by the instant-filter chip row.
export const PRESETS = {
  today:      () => { const t = todayIST(); return { from: t, to: t }; },
  yesterday:  () => { const y = addDaysISO(todayIST(), -1); return { from: y, to: y }; },
  this_week:  () => weekRange(todayIST()),
  this_month: () => monthRange(todayIST()),
};

export const PRESET_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This Week',
  this_month: 'This Month',
};

// Trigger a CSV download in the browser. Rows is an array of arrays.
export function downloadCSV(filename, headers, rows) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
