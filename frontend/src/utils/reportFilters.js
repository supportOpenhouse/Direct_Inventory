// Date helpers shared by the Report list and per-user detail pages.
// All boundaries are IST calendar dates. To stay free of browser-timezone
// drift, every operation works on YYYY-MM-DD strings with pure UTC math.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const EPOCH_START = '2000-01-01'; // open-ended start for the "All" preset

export function todayIST() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekRange(refIso) {
  const dow = (new Date(refIso + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const from = addDaysISO(refIso, -dow);
  return { from, to: addDaysISO(from, 6) };
}

function monthRange(refIso) {
  const [y, m] = refIso.split('-').map(Number);
  const mm = String(m).padStart(2, '0');
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

export const PRESETS = {
  all: () => ({ from: EPOCH_START, to: todayIST() }),
  today: () => { const t = todayIST(); return { from: t, to: t }; },
  yesterday: () => { const y = addDaysISO(todayIST(), -1); return { from: y, to: y }; },
  this_week: () => weekRange(todayIST()),
  this_month: () => monthRange(todayIST()),
};

export const PRESET_LABELS = {
  all: 'All',
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This Week',
  this_month: 'This Month',
};

// Trigger a CSV download in the browser. rows is an array of arrays.
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
