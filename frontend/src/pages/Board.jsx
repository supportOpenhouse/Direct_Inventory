import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { CITIES, STAGES, STAGE_DOT_COLOR, stageLabel } from '../utils/format.js';
import { downloadCSV } from '../utils/reportFilters.js';
import InventoryTable from '../components/InventoryTable.jsx';
import CardDetailModal from '../components/CardDetailModal.jsx';
import AddInventoryModal from '../components/AddInventoryModal.jsx';
import FilterPanel from '../components/FilterPanel.jsx';
import BulkActionBar from '../components/BulkActionBar.jsx';

const PAGE_SIZE = 100;

export default function Board() {
  const { user } = useAuth();
  // Search — committed-only to avoid per-keystroke races.
  const [qInput, setQInput] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [city, setCity] = useState('');
  // Multi-select stage filter. Empty set = "All".
  const [stageSel, setStageSel] = useState(() => new Set());
  // 'smart' — follow-up triage default: today, then overdue (Follow Up >
  // Lead > others), then future. Clicking a column header switches to a
  // plain column sort. See inventory.list_inventory for the SQL.
  const [sort, setSort] = useState({ field: 'smart', dir: 'desc' });
  const [page, setPage] = useState(0);
  // Mirrors `page + 1` (1-indexed) for the jump-to-page input. Kept as a
  // string so the field can be cleared mid-typing.
  const [pageInput, setPageInput] = useState('1');

  // Extended filters from the FilterPanel modal.
  const [filtersApplied, setFiltersApplied] = useState({});
  const [filterFormState, setFilterFormState] = useState({});
  const [showFilters, setShowFilters] = useState(false);

  // Bulk-select mode.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());

  // Admin-triggered CP match scan.
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);

  // Detail modal for the clicked row.
  const [openItem, setOpenItem] = useState(null);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [counts, setCounts] = useState({ total: 0, by_stage: {} });
  const [showAdd, setShowAdd] = useState(false);

  // Background POC-backfill notification. After the first inventory load
  // completes, kick off /assign-missing once; if any new leads were assigned,
  // show a top-right banner asking the user to reload.
  const [newAssigned, setNewAssigned] = useState(0);
  const assignCheckedRef = useRef(false);

  // Admin-only CSV export — paginates through the list endpoint with the
  // currently-applied filters, builds the CSV client-side.
  const [downloadingCsv, setDownloadingCsv] = useState(false);

  function makeParams() {
    const p = new URLSearchParams();
    if (qApplied) p.set('q', qApplied);
    if (city) p.set('city', city);
    if (stageSel.size > 0) p.set('stage', Array.from(stageSel).join(','));
    if (sort.field) {
      p.set('sort', sort.field);
      p.set('dir', sort.dir);
    }
    for (const [k, v] of Object.entries(filtersApplied)) p.set(k, String(v));
    return p;
  }

  async function refresh(currentPage = page) {
    setLoading(true);
    try {
      const params = makeParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(currentPage * PAGE_SIZE));
      const r = await api.get(`/api/inventory?${params}`);
      setItems(r.items);
      setTotal(r.total);
    } finally {
      setLoading(false);
    }
  }

  async function refreshCounts() {
    try {
      const params = makeParams();
      const r = await api.get(`/api/inventory/counts?${params}`);
      setCounts(r);
    } catch { /* non-blocking */ }
  }

  // Reset to page 0 + reload whenever filters / sort / search change.
  useEffect(() => {
    setPage(0);
    refresh(0);
    refreshCounts();
    /* eslint-disable-next-line */
  }, [city, qApplied, stageSel, filtersApplied, sort.field, sort.dir]);
  useEffect(() => { refresh(page); /* eslint-disable-next-line */ }, [page]);
  // Keep the jump-to-page field in sync whenever `page` changes elsewhere
  // (Prev/Next, filter reset). Does not fire while the user is mid-typing.
  useEffect(() => { setPageInput(String(page + 1)); }, [page]);

  // Once the table has painted at least once, ask the backend to assign POCs
  // to any new leads with no RM. Runs once per page mount, in the background;
  // never blocks rendering. A non-zero result triggers the reload banner.
  useEffect(() => {
    if (loading || assignCheckedRef.current) return;
    assignCheckedRef.current = true;
    api.post('/api/inventory/assign-missing', {})
      .then((r) => { if (r?.updated > 0) setNewAssigned(r.updated); })
      .catch(() => { /* silent — purely a background nicety */ });
  }, [loading]);

  function onSearch(e) {
    e?.preventDefault();
    setQApplied(qInput.trim());
  }

  function toggleStage(s) {
    setStageSel((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }
  function clearStages() { setStageSel(new Set()); }

  function patchItemInState(updated) {
    setItems((prev) => prev.map((it) => (it.oh_id === updated.oh_id ? { ...it, ...updated } : it)));
    if (openItem && openItem.oh_id === updated.oh_id) {
      setOpenItem((p) => ({ ...p, ...updated }));
    }
  }

  function toggleSelect(oh_id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(oh_id)) next.delete(oh_id); else next.add(oh_id);
      return next;
    });
  }
  function clearSelection() { setSelected(new Set()); }
  function exitSelectMode() { setSelectMode(false); clearSelection(); }

  async function runCpScan() {
    if (scanning) return;
    if (!window.confirm('Run CP Inventory match scan? This only checks rows that haven’t been scanned yet (or were edited since the last scan).')) return;
    setScanning(true);
    setScanProgress(0);
    try {
      let cursor = '';
      let totals = { perfect: 0, partial: 0, no_match: 0 };
      let processed = 0;
      while (true) {
        const r = await api.post('/api/inventory/cp-match-scan', {
          cursor,
          prior_totals: totals,
        });
        totals = {
          perfect: totals.perfect + r.perfect,
          partial: totals.partial + r.partial,
          no_match: totals.no_match + r.no_match,
        };
        processed += r.processed;
        setScanProgress(processed);
        if (r.done) break;
        cursor = r.next_cursor;
      }
      const total = totals.perfect + totals.partial + totals.no_match;
      alert(
        `CP scan complete — ${total} rows.\n` +
        `Perfect: ${totals.perfect}\nPartial: ${totals.partial}\nNo match: ${totals.no_match}`
      );
      refresh(page);
      refreshCounts();
    } catch (e) {
      alert('Scan failed: ' + (e.data?.error || e.message));
    } finally {
      setScanning(false);
      setScanProgress(0);
    }
  }

  // Pulls every row matching the current filters (paginated at the API's
  // 1000-row cap) and writes a CSV. Admin-only — gated in the UI.
  async function downloadCsv() {
    if (downloadingCsv) return;
    setDownloadingCsv(true);
    try {
      const all = [];
      const pageLimit = 1000;
      let offset = 0;
      // Loop until the server says we've seen them all. Cap at 50 pages so a
      // runaway response can't spin forever.
      for (let i = 0; i < 50; i += 1) {
        const params = makeParams();
        params.set('limit', String(pageLimit));
        params.set('offset', String(offset));
        const r = await api.get(`/api/inventory?${params}`);
        const batch = r.items || [];
        all.push(...batch);
        if (batch.length < pageLimit || all.length >= (r.total || 0)) break;
        offset += pageLimit;
      }
      const fmtDate = (d) => {
        if (!d) return '';
        const dt = new Date(d);
        return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
      };
      const headers = [
        'OH-ID', 'City', 'Locality', 'Society', 'BHK', 'Floor', 'Tower', 'Unit',
        'Area (sqft)', 'Asking (Lakhs)', 'OH Price (Lakhs)', 'Variation %',
        'Stage', 'Reject Reason', 'Seller', 'Phone', 'Posting Date', 'Created',
        'Follow-up', 'Notes', 'Source', 'Listing Link',
      ];
      const rows = all.map((it) => {
        const variation = it.price != null && it.oh_price
          ? ((Number(it.price) - Number(it.oh_price)) / Number(it.oh_price) * 100).toFixed(1)
          : '';
        return [
          it.oh_id,
          it.city || '',
          it.locality || '',
          it.society || '',
          it.bedrooms ?? '',
          it.floor ?? '',
          it.tower || '',
          it.unit_no || '',
          it.area_sqft ?? '',
          it.price != null ? (Number(it.price) / 100000).toFixed(2) : '',
          it.oh_price != null ? (Number(it.oh_price) / 100000).toFixed(2) : '',
          variation,
          stageLabel(it.stage),
          it.reject_reason || '',
          it.seller_name || '',
          it.seller_phone || '',
          fmtDate(it.posting_date),
          fmtDate(it.created_at),
          fmtDate(it.follow_up_at),
          it.notes || '',
          it.source || '',
          it.listing_link || '',
        ];
      });
      const filename = `inventory_${new Date().toISOString().slice(0, 10)}.csv`;
      downloadCSV(filename, headers, rows);
    } catch (e) {
      alert('Download failed: ' + (e?.data?.error || e?.message || e));
    } finally {
      setDownloadingCsv(false);
    }
  }

  function onBulkDone(result) {
    clearSelection();
    setSelectMode(false);
    refreshCounts();
    refresh(page);
    if (result?.skipped_forbidden?.length || result?.not_found?.length) {
      alert(
        `Updated ${result.updated} of ${result.requested}.\n` +
        (result.skipped_forbidden?.length ? `Forbidden: ${result.skipped_forbidden.length}\n` : '') +
        (result.not_found?.length ? `Not found: ${result.not_found.length}` : '')
      );
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filterCount = Object.keys(filtersApplied).length;

  // Commit the jump-to-page field: parse, clamp to [1, totalPages], jump.
  // Empty / invalid input snaps back to the current page.
  function commitPageInput() {
    const n = parseInt(pageInput, 10);
    if (Number.isNaN(n)) {
      setPageInput(String(page + 1));
      return;
    }
    const clamped = Math.min(Math.max(n, 1), totalPages);
    setPageInput(String(clamped));
    if (clamped - 1 !== page) setPage(clamped - 1);
  }

  return (
    <div className="board-page">
      {newAssigned > 0 && (
        <button
          type="button"
          className="new-assigned-banner"
          onClick={() => { setNewAssigned(0); refresh(page); refreshCounts(); }}
          title="Click to reload the table"
        >
          NEW LEADS ASSIGNED, PLEASE RELOAD
        </button>
      )}
      <div className="board-toolbar">
        <div className="city-tabs">
          <button className={!city ? 'tab tab-active' : 'tab'} onClick={() => setCity('')}>All</button>
          {CITIES.map((c) => (
            <button key={c} className={city === c ? 'tab tab-active' : 'tab'} onClick={() => setCity(c)}>{c}</button>
          ))}
        </div>
        <form className="search-form" onSubmit={onSearch}>
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Search society, OH-ID, seller, locality, source… (press Enter)"
          />
          <button type="submit" className="btn-primary">Search</button>
          {qApplied && (
            <button type="button" className="btn-ghost" onClick={() => { setQInput(''); setQApplied(''); }}>
              Clear
            </button>
          )}
        </form>
        <button className="btn-ghost" onClick={() => setShowFilters(true)}>
          Filters{filterCount ? ` (${filterCount})` : ''}
        </button>
        {filterCount > 0 && (
          <button className="btn-link" onClick={() => { setFiltersApplied({}); setFilterFormState({}); }}>
            Reset
          </button>
        )}
        <div className="toolbar-spacer" />
        <button
          className={selectMode ? 'btn-primary' : 'btn-ghost'}
          onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
        >
          {selectMode ? 'Exit Select' : 'Select'}
        </button>
        <button className="btn-ghost" onClick={runCpScan} disabled={scanning}>
          {scanning ? `Scanning… ${scanProgress}` : 'Re-scan CP'}
        </button>
        <button className="btn-primary" onClick={() => setShowAdd(true)}>+ Add Inventory</button>
      </div>

      {selectMode && selected.size > 0 && (
        <BulkActionBar
          selected={selected}
          role={user?.role}
          onCleared={exitSelectMode}
          onDone={onBulkDone}
        />
      )}

      <div className="stage-counts">
        <button
          type="button"
          className={stageSel.size === 0 ? 'count-pill count-pill-active' : 'count-pill'}
          onClick={clearStages}
        >
          <div className="num">{counts.total}</div><div className="lbl">ALL</div>
        </button>
        {STAGES.map((s) => (
          <button
            key={s}
            type="button"
            className={stageSel.has(s) ? 'count-pill count-pill-active' : 'count-pill'}
            onClick={() => toggleStage(s)}
          >
            <div className="num" style={{ color: STAGE_DOT_COLOR[s] }}>{counts.by_stage?.[s] ?? 0}</div>
            <div className="lbl">{stageLabel(s).toUpperCase()}</div>
          </button>
        ))}
      </div>

      <div className="filtered-header">
        <span className="muted">
          Showing {items.length === 0 ? 0 : page * PAGE_SIZE + 1}
          –{page * PAGE_SIZE + items.length} of {total}
        </span>
        <span className="toolbar-spacer" />
        <button className="btn-ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Prev</button>
        <span className="page-num">
          Page{' '}
          <input
            className="page-jump"
            type="text"
            inputMode="numeric"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            onBlur={commitPageInput}
            aria-label="Go to page"
          />
          {' / '}{totalPages}
        </span>
        <button className="btn-ghost" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button>
        <button
          className="btn-ghost reload-btn"
          onClick={() => { refresh(page); refreshCounts(); }}
          disabled={loading}
          title="Reload the table (keeps current filters)"
          aria-label="Reload"
        >
          <span className={`reload-icon ${loading ? 'reload-icon-spinning' : ''}`}>↻</span>
        </button>
        {user?.role === 'admin' && (
          <button
            className="btn-ghost"
            onClick={downloadCsv}
            disabled={downloadingCsv || total === 0}
            title="Download all rows matching the current filters as CSV"
          >
            {downloadingCsv ? 'Downloading…' : 'Download CSV'}
          </button>
        )}
      </div>

      <InventoryTable
        items={items}
        loading={loading}
        role={user?.role}
        sort={sort}
        onSort={setSort}
        onRowClick={(it) => setOpenItem(it)}
        onUpdated={patchItemInState}
        selectMode={selectMode}
        selected={selected}
        onToggleSelect={toggleSelect}
        showStageColumn={stageSel.size === 0}
      />

      {openItem && (
        <CardDetailModal
          item={openItem}
          role={user?.role}
          onUpdated={patchItemInState}
          onClose={() => setOpenItem(null)}
        />
      )}

      {showAdd && (
        <AddInventoryModal
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            refreshCounts();
            refresh(0);
          }}
        />
      )}

      {showFilters && (
        <FilterPanel
          initial={filterFormState}
          defaultCity={city}
          role={user?.role}
          onClose={() => setShowFilters(false)}
          onApply={(applied, formState) => {
            setFiltersApplied(applied);
            setFilterFormState(formState);
            setShowFilters(false);
          }}
        />
      )}
    </div>
  );
}
