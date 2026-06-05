// In-memory mock backend. Mirrors the shapes the real Flask API returns so the
// whole UI is browsable before the backend exists. The client (client.js) routes
// here whenever a real /api request can't reach a server (or VITE_USE_MOCKS forces it).
//
// Everything mutates a module-level dataset so optimistic edits, stage moves,
// note posts, etc. persist for the session. Refresh resets to seed.

import { todayISO } from '../utils/format.js';

// ── tiny deterministic helpers (no Math.random so re-renders stay stable) ──
let _seq = 1000;
const nextId = () => (_seq += 1);

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}
function dateOnlyFromNow(n) {
  return daysFromNow(n).slice(0, 10);
}

const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];
const SOCIETIES = {
  Gurgaon: [
    ['DLF The Crest', 'Sector 54'],
    ['M3M Golf Estate', 'Sector 65'],
    ['Ireo Victory Valley', 'Sector 67'],
    ['Tata Primanti', 'Sector 72'],
    ['Emaar Palm Gardens', 'Sector 83'],
  ],
  Noida: [
    ['ATS Greens Village', 'Sector 93A'],
    ['Jaypee Greens Kosmos', 'Sector 134'],
    ['Supertech Capetown', 'Sector 74'],
    ['Mahagun Moderne', 'Sector 78'],
  ],
  Ghaziabad: [
    ['Wave City', 'NH-24'],
    ['Gaur City 2', 'Greater Noida West'],
    ['Ajnara Daffodil', 'Sector 137'],
  ],
};
const SELLERS = [
  ['Rajesh Kumar', '9810012345'],
  ['Priya Sharma', '9820023456'],
  ['Amit Verma', '9830034567'],
  ['Sneha Gupta', '9840045678'],
  ['Vikram Singh', '9850056789'],
  ['Neha Bansal', '9860067890'],
];
const SOURCES = ['99acres', 'MagicBricks', 'Housing.com', 'Website'];
const STAGES_POOL = ['lead', 'lead', 'lead', 'qualified', 'qualified', 'call_not_received', 'follow_up', 'visit_scheduled', 'rejected'];

// ── seed inventory ──
function seedInventory() {
  const items = [];
  let n = 0;
  for (const city of CITIES) {
    const socs = SOCIETIES[city];
    for (let s = 0; s < socs.length; s += 1) {
      const [society, locality] = socs[s];
      const perSoc = 6;
      for (let i = 0; i < perSoc; i += 1) {
        n += 1;
        const stage = STAGES_POOL[(n + i) % STAGES_POOL.length];
        const [sellerName, sellerPhone] = SELLERS[n % SELLERS.length];
        const bedrooms = 2 + (n % 2); // 2 or 3
        const area = 1100 + (n % 6) * 220;
        // price in rupees (BIGINT in the DB). ~1.1cr – 3.4cr
        const askingL = 110 + (n % 14) * 18;
        const price = askingL * 100000;
        const hasOh = n % 3 !== 0;
        const ohPrice = hasOh ? Math.round(price * (0.9 + ((n % 5) * 0.03))) : null;
        // created: spread today..40 days ago; a few today for "NEW"
        const createdOffset = (n % 7 === 0) ? 0 : -(n % 40) - 1;
        const followUp = stage === 'follow_up'
          ? dateOnlyFromNow((n % 3) - 1) // some past, today, future
          : (stage === 'call_not_received' && n % 2 === 0 ? dateOnlyFromNow((n % 4) + 1) : null);
        items.push({
          oh_id: `DI${1000 + n}`,
          city,
          locality,
          society,
          bedrooms,
          floor: String(1 + (n % 24)),
          tower: `T${1 + (n % 6)}`,
          unit_no: `${100 + n}`,
          area_sqft: area,
          price,
          oh_price: ohPrice,
          oh_price_match: hasOh && n % 4 === 0 ? 'nearest' : 'exact',
          oh_price_bhk: bedrooms,
          oh_price_area: area,
          stage,
          stage_reason: stage === 'rejected' ? ['ground_floor', 'listing_removed', 'invalid_duplicate'][n % 3] : null,
          seller_name: sellerName,
          seller_phone: sellerPhone,
          source: SOURCES[n % SOURCES.length],
          listing_link: n % 5 === 0 ? null : `https://www.${SOURCES[n % SOURCES.length].toLowerCase().replace(/[^a-z]/g, '')}.com/listing/${1000 + n}`,
          posting_date: dateOnlyFromNow(-(n % 30) - 1),
          created_at: daysFromNow(createdOffset),
          follow_up_at: followUp,
          priority: n % 11 === 0,
          star_color: n % 13 === 0 ? 'green' : (n % 17 === 0 ? 'red' : null),
          cp_match: n % 13 === 0 ? 'perfect' : (n % 17 === 0 ? 'partial' : null),
          assigned_rms: n % 3 === 0 ? [{ id: 3, name: 'Ravi Sharma', email: 'ravi@openhouse.in' }] : [],
          assigned_rm_ids: n % 3 === 0 ? [3] : [],
          note_thread: n % 4 === 0
            ? [{ id: nextId(), body: 'Spoke to seller, interested. Will share photos.', author_name: 'Ravi Sharma', author_email: 'ravi@openhouse.in', created_at: daysFromNow(-1) }]
            : [],
        });
      }
    }
  }
  return items;
}

const DB = {
  inventory: seedInventory(),
  users: [
    { id: 1, email: 'admin@openhouse.in', name: 'Aarav Admin', phone: '9900000001', role: 'admin', is_active: true, manager: null, manager_name: null, manager_email: null, cities: [...CITIES], micro_market: [], society: [] },
    { id: 2, email: 'manager@openhouse.in', name: 'Meera Manager', phone: '9900000002', role: 'manager', is_active: true, manager: null, manager_name: null, manager_email: null, cities: ['Gurgaon'], micro_market: [], society: [] },
    { id: 3, email: 'ravi@openhouse.in', name: 'Ravi Sharma', phone: '9900000003', role: 'rm', is_active: true, manager: 2, manager_name: 'Meera Manager', manager_email: 'manager@openhouse.in', cities: ['Gurgaon'], micro_market: ['Golf Course Ext'], society: ['DLF The Crest'] },
    { id: 4, email: 'sara@openhouse.in', name: 'Sara Khan', phone: '9900000004', role: 'rm', is_active: true, manager: 2, manager_name: 'Meera Manager', manager_email: 'manager@openhouse.in', cities: ['Noida'], micro_market: [], society: ['ATS Greens Village'] },
    { id: 5, email: 'old@openhouse.in', name: 'Inactive User', phone: '', role: 'rm', is_active: false, manager: 2, manager_name: 'Meera Manager', manager_email: 'manager@openhouse.in', cities: [], micro_market: [], society: [] },
  ],
  activity: seedActivity(),
};

function seedActivity() {
  const out = [];
  const actors = [
    ['admin@openhouse.in', 'Aarav Admin'],
    ['ravi@openhouse.in', 'Ravi Sharma'],
    ['sara@openhouse.in', 'Sara Khan'],
  ];
  for (let i = 0; i < 60; i += 1) {
    const [email, name] = actors[i % actors.length];
    const ohId = `DI${1001 + (i % 40)}`;
    out.push({
      id: nextId(),
      created_at: daysFromNow(-(i % 14)),
      entity_id: ohId,
      entity_type: 'inventory',
      actor_email: email,
      actor_name: name,
      action: ['stage_change', 'note_added', 'create', 'login'][i % 4],
      field: i % 4 === 0 ? 'stage' : (i % 4 === 1 ? 'note' : null),
      before_value: i % 4 === 0 ? 'lead' : null,
      after_value: i % 4 === 0 ? 'qualified' : (i % 4 === 1 ? 'Followed up with seller' : null),
      metadata: i % 4 === 1 ? { author_name: name } : null,
    });
  }
  return out;
}

// ── query helpers ──
function applyInventoryFilters(items, params) {
  let out = items.slice();
  const q = (params.get('q') || '').toLowerCase();
  if (q) {
    out = out.filter((it) => [it.society, it.oh_id, it.seller_name, it.locality, it.source]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
  }
  const city = params.get('city');
  if (city) out = out.filter((it) => it.city === city);
  const stage = params.get('stage');
  if (stage) {
    const set = new Set(stage.split(','));
    out = out.filter((it) => set.has(it.stage));
  }
  const bhk = params.get('bhk');
  if (bhk) {
    const set = new Set(bhk.split(',').map(Number));
    out = out.filter((it) => set.has(Number(it.bedrooms)));
  }
  const society = params.get('society');
  if (society) {
    const set = new Set(society.split(','));
    out = out.filter((it) => set.has(it.society));
  }
  const source = params.get('source');
  if (source) out = out.filter((it) => (it.source || '').toLowerCase().includes(source.toLowerCase()));
  // sort
  const sort = params.get('sort');
  const dir = params.get('dir') === 'asc' ? 1 : -1;
  if (sort && sort !== 'smart') {
    out.sort((a, b) => {
      let av = a[sort];
      let bv = b[sort];
      if (sort === 'variation') {
        av = a.oh_price ? (a.price - a.oh_price) / a.oh_price : -Infinity;
        bv = b.oh_price ? (b.price - b.oh_price) / b.oh_price : -Infinity;
      }
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  } else {
    // "smart": newest first
    out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  return out;
}

function paginate(out, params) {
  const limit = Number(params.get('limit') || 100);
  const offset = Number(params.get('offset') || 0);
  return { items: out.slice(offset, offset + limit), total: out.length };
}

function parse(path) {
  const [p, qs] = path.split('?');
  return { p, params: new URLSearchParams(qs || '') };
}

function findItem(ohId) {
  return DB.inventory.find((it) => it.oh_id === ohId);
}

// ── the resolver ──
// Returns the JSON body the real API would, or throws { status, data } for 4xx.
export function mockApi(method, path, body) {
  const { p, params } = parse(path);

  // auth
  if (p === '/api/auth/me') {
    const email = localStorage.getItem('di_mock_email') || 'admin@openhouse.in';
    const user = DB.users.find((u) => u.email === email) || DB.users[0];
    return { user };
  }
  if (p === '/api/auth/google' || p === '/api/auth/dev') {
    const email = body?.email || 'admin@openhouse.in';
    const user = DB.users.find((u) => u.email === email) || DB.users[0];
    localStorage.setItem('di_mock_email', user.email);
    return { token: `mock.${user.email}`, user };
  }

  // inventory list / counts
  if (p === '/api/inventory' && method === 'GET') {
    const filtered = applyInventoryFilters(DB.inventory, params);
    return paginate(filtered, params);
  }
  if (p === '/api/inventory/counts') {
    const filtered = applyInventoryFilters(DB.inventory, params);
    const by_stage = {};
    for (const it of filtered) by_stage[it.stage] = (by_stage[it.stage] || 0) + 1;
    return { total: filtered.length, by_stage };
  }
  if (p === '/api/inventory/societies') {
    const city = params.get('city');
    const seen = [];
    for (const it of DB.inventory) {
      if (city && it.city !== city) continue;
      seen.push({ society: it.society, locality: it.locality });
    }
    return { items: seen };
  }
  if (p === '/api/inventory/notifications') {
    const new_items = DB.inventory.filter((it) => {
      const d = new Date(it.created_at);
      return (Date.now() - d.getTime()) < 86400_000;
    }).slice(0, 20);
    const today_follow_ups = DB.inventory.filter((it) => (it.follow_up_at || '').slice(0, 10) === todayISO()).slice(0, 20);
    return { new_items, today_follow_ups, total: new_items.length + today_follow_ups.length };
  }
  if (p === '/api/inventory/assign-missing') return { updated: 0, scanned: DB.inventory.length, remaining: 0 };
  if (p === '/api/inventory/cp-match-scan') {
    return { processed: DB.inventory.length, perfect: 4, partial: 6, no_match: DB.inventory.length - 10, done: true, next_cursor: '' };
  }
  if (p === '/api/inventory/bulk-update' && method === 'POST') {
    const ids = body?.oh_ids || [];
    const updates = body?.updates || {};
    let updated = 0;
    for (const id of ids) {
      const it = findItem(id);
      if (it) { Object.assign(it, updates); updated += 1; }
    }
    return { updated, requested: ids.length, skipped_forbidden: [], not_found: [] };
  }

  // single item: GET /api/inventory/:id, PATCH, notes, assigned-rms
  const invMatch = p.match(/^\/api\/inventory\/([^/]+)(\/notes|\/assigned-rms)?$/);
  if (invMatch) {
    const it = findItem(invMatch[1]);
    if (!it) throw { status: 404, data: { error: 'not found' } };
    const sub = invMatch[2];
    if (!sub && method === 'GET') return it;
    if (!sub && method === 'PATCH') {
      Object.assign(it, body || {});
      return { item: it };
    }
    if (sub === '/notes' && method === 'POST') {
      const note = {
        id: nextId(),
        body: body.body,
        author_name: (DB.users.find((u) => u.email === localStorage.getItem('di_mock_email')) || DB.users[0]).name,
        author_email: localStorage.getItem('di_mock_email') || 'admin@openhouse.in',
        created_at: new Date().toISOString(),
      };
      it.note_thread = [...(it.note_thread || []), note];
      return { note, note_thread: it.note_thread };
    }
    if (sub === '/assigned-rms' && method === 'PUT') {
      const ids = body?.rm_ids || [];
      it.assigned_rm_ids = ids;
      it.assigned_rms = ids.map((id) => {
        const u = DB.users.find((x) => x.id === id);
        return u ? { id: u.id, name: u.name, email: u.email } : { id };
      });
      return { item: it };
    }
  }

  // users
  if (p === '/api/users' && method === 'GET') {
    const role = params.get('role');
    let items = DB.users.slice();
    if (role) items = items.filter((u) => u.role === role);
    return { items };
  }
  if (p === '/api/users' && method === 'POST') {
    const u = { id: nextId(), is_active: true, manager: null, micro_market: [], society: [], cities: [], ...body };
    DB.users.push(u);
    return u;
  }
  if (p === '/api/users/master-areas') {
    const societies = [...new Set(DB.inventory.map((it) => it.society))].sort();
    const micro_markets = ['Golf Course Ext', 'Dwarka Expressway', 'Sohna Road', 'Noida Expressway'];
    return { cities: CITIES, micro_markets, societies };
  }
  const userMatch = p.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && method === 'PATCH') {
    const u = DB.users.find((x) => x.id === Number(userMatch[1]));
    if (!u) throw { status: 404, data: { error: 'not found' } };
    Object.assign(u, body);
    if (body.manager != null) {
      const mgr = DB.users.find((x) => x.id === body.manager);
      u.manager_name = mgr?.name || null;
      u.manager_email = mgr?.email || null;
    }
    return u;
  }

  // visits
  if (p === '/api/visits/field-execs') {
    return { items: [
      { id: 1, name: 'Field Exec One', phone: '9700000001' },
      { id: 2, name: 'Field Exec Two', phone: '9700000002' },
    ] };
  }
  if (p === '/api/visits/assignees') {
    return { items: DB.users.filter((u) => u.role !== 'rm' || true).map((u) => ({ id: u.id, name: u.name, email: u.email })) };
  }
  if (p === '/api/visits/society-units') return { items: [] };
  if (p === '/api/visits/schedule' && method === 'POST') {
    const it = findItem(body.oh_id);
    if (it) { it.stage = 'visit_scheduled'; it.visit_at = `${body.schedule_date}T${body.schedule_time}`; it.forms_visit_id = `FV${nextId()}`; }
    return it || {};
  }

  // activity
  if (p === '/api/activity' && method === 'GET') {
    let items = DB.activity.slice();
    const q = (params.get('q') || '').toLowerCase();
    if (q) items = items.filter((a) => (a.entity_id || '').toLowerCase().includes(q));
    const action = params.get('action');
    if (action) items = items.filter((a) => a.action === action);
    const et = params.get('entity_type');
    if (et) items = items.filter((a) => a.entity_type === et);
    const actor = params.get('actor_email');
    if (actor) items = items.filter((a) => a.actor_email === actor);
    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return { items: items.slice(0, Number(params.get('limit') || 500)), total: items.length };
  }
  if (p === '/api/activity/filters') {
    return {
      actions: [...new Set(DB.activity.map((a) => a.action))],
      entity_types: [...new Set(DB.activity.map((a) => a.entity_type))],
      actors: DB.users.map((u) => ({ email: u.email, name: u.name })),
    };
  }
  if (p === '/api/activity/user-report') {
    const users = DB.users.filter((u) => u.is_active).map((u) => {
      const acts = DB.activity.filter((a) => a.actor_email === u.email);
      const counts = {};
      for (const a of acts) {
        const s = a.after_value && ['lead', 'qualified', 'call_not_received', 'follow_up', 'visit_scheduled', 'rejected'].includes(a.after_value) ? a.after_value : 'qualified';
        counts[s] = (counts[s] || 0) + 1;
      }
      return {
        actor_email: u.email,
        actor_name: u.name,
        actor_role: u.role,
        total: acts.length,
        unique_leads: new Set(acts.map((a) => a.entity_id)).size,
        days_active: new Set(acts.map((a) => a.created_at.slice(0, 10))).size,
        counts,
      };
    }).filter((u) => u.total > 0);
    return { from: params.get('from'), to: params.get('to'), users };
  }
  if (p === '/api/activity/user-report/days') {
    const email = params.get('email');
    const acts = DB.activity.filter((a) => a.actor_email === email);
    const byDay = {};
    for (const a of acts) {
      const day = a.created_at.slice(0, 10);
      byDay[day] = byDay[day] || { day, total: 0, counts: {} };
      byDay[day].total += 1;
      const s = a.after_value && ['lead', 'qualified', 'call_not_received', 'follow_up', 'visit_scheduled', 'rejected'].includes(a.after_value) ? a.after_value : 'qualified';
      byDay[day].counts[s] = (byDay[day].counts[s] || 0) + 1;
    }
    const u = DB.users.find((x) => x.email === email);
    return {
      email,
      actor_name: u?.name || null,
      actor_role: u?.role || null,
      unique_leads: new Set(acts.map((a) => a.entity_id)).size,
      from: params.get('from'),
      to: params.get('to'),
      days: Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1)),
    };
  }
  if (p === '/api/activity/user-report/leads') {
    const acts = DB.activity.filter((a) => a.actor_email === params.get('email')).slice(0, 12);
    return {
      leads: acts.map((a) => {
        const it = findItem(a.entity_id) || {};
        return {
          oh_id: a.entity_id,
          society: it.society,
          city: it.city,
          seller_name: it.seller_name,
          from_stage: a.before_value || 'lead',
          final_stage: a.after_value || it.stage || 'qualified',
          current_stage: it.stage || 'qualified',
          stage_reason: it.stage_reason,
          last_change_at: a.created_at,
          notes: '',
        };
      }),
    };
  }
  if (p === '/api/activity/user-report/analytics') {
    const days = {};
    for (const a of DB.activity) {
      const day = a.created_at.slice(0, 10);
      days[day] = days[day] || { day, total: 0, counts: {}, by_user: {} };
      days[day].total += 1;
      const s = a.after_value && ['lead', 'qualified', 'call_not_received', 'follow_up', 'visit_scheduled', 'rejected'].includes(a.after_value) ? a.after_value : 'qualified';
      days[day].counts[s] = (days[day].counts[s] || 0) + 1;
      days[day].by_user[a.actor_email] = (days[day].by_user[a.actor_email] || 0) + 1;
    }
    const funnel = { qualified: 80, visit_scheduled: 22, visit_completed: 9, offer_given: 3 };
    const user_names = {};
    for (const u of DB.users) user_names[u.email] = u.name;
    return {
      daily_trend: Object.values(days).sort((a, b) => (a.day < b.day ? -1 : 1)),
      funnel,
      user_names,
    };
  }

  // Post Token stages (placeholder; wired to another DB later).
  if (p === '/api/post-token/counts') {
    return { by_stage: { token_transferred: 12, docs_received: 8, ama_signed: 5, key_handover: 3 } };
  }

  // Home board summary — the Leads / Follow Ups / Rejected quadrants. (The
  // Pipeline quadrant uses the separate post-token dataset, computed client-
  // side.) Backend should implement this as one scoped aggregate.
  if (p === '/api/home/summary') {
    const today = todayISO();
    const created = (it) => {
      const d = new Date(it.created_at);
      if (Number.isNaN(d.getTime())) return null;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const olderToday = (items) => items.filter((it) => { const c = created(it); return c && c < today; }).length;
    const byStage = (st) => DB.inventory.filter((it) => it.stage === st);
    const leads = byStage('lead');
    const active = byStage('active');
    const quals = byStage('qualified');
    const fuStage = byStage('follow_up');
    const rejected = byStage('rejected');
    const by_reason = {};
    for (const it of rejected) { const r = it.stage_reason || 'unspecified'; by_reason[r] = (by_reason[r] || 0) + 1; }
    const SUPPLY = ['pipeline', 'token_to_ama', 'onboarded', 'rejected_post_visit', 'cancelled_post_token'];
    const supply = {};
    for (const st of SUPPLY) supply[st] = byStage(st).length;
    // Mock has no activity history, so "new" (entered-stage-today) can't be
    // derived for active/follow_up — those fall to 0/old. Lead-new uses created
    // today; qualified-new approximated by created today.
    return {
      leads: {
        lead_new: leads.filter((it) => created(it) === today).length,
        lead_old: leads.filter((it) => { const c = created(it); return c && c < today; }).length,
        active_new: 0,
        active_old: active.length,
      },
      qualified: { new: quals.filter((it) => created(it) === today).length, old: olderToday(quals) },
      follow_up: { new: 0, old: fuStage.length },
      visit: { completed: Object.values(supply).reduce((a, b) => a + b, 0), to_be_completed: 0, overdue: 0 },
      supply,
      rejected: { total: rejected.length, by_reason },
      todays_task: (() => {
        const createdToday = DB.inventory.filter((it) => created(it) === today);
        const ttTotal = createdToday.length;
        const ttTask1 = createdToday.filter((it) => !['lead', 'unqualified'].includes(it.stage)).length;
        const task1Done = ttTask1 >= ttTotal;
        const ttTask2 = task1Done ? createdToday.filter((it) => !['lead', 'unqualified', 'active'].includes(it.stage)).length : null;
        return { leads: { total: ttTotal, worked: ttTask1 }, active: { total: ttTotal, worked: ttTask2 } };
      })(),
    };
  }

  if (p === '/api/home/task-tracking') {
    const today = todayISO();
    const createdToday = (it) => {
      const d = new Date(it.created_at);
      if (Number.isNaN(d.getTime())) return false;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === today;
    };
    const byUser = {};
    for (const it of DB.inventory) {
      if (!createdToday(it)) continue;
      for (const rmId of (it.assigned_rm_ids || [])) {
        const u = DB.users.find((x) => x.id === rmId);
        if (!u || u.is_active === false) continue; // match backend AND u.is_active
        const b = byUser[rmId] || (byUser[rmId] = { id: u.id, name: u.name, email: u.email, role: u.role, total: 0, task1_worked: 0, task2_worked: 0 });
        b.total += 1;
        if (!['lead', 'unqualified'].includes(it.stage)) b.task1_worked += 1;
        if (!['lead', 'unqualified', 'active'].includes(it.stage)) b.task2_worked += 1;
      }
    }
    return { users: Object.values(byUser).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email)) };
  }

  // Unknown — return empty so callers degrade gracefully.
  return null;
}
