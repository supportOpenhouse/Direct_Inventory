import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import InventoryBoard from '../components/InventoryBoard.jsx';
import { SUPPLY_STAGES, ALL_SUPPLY_REASONS } from '../utils/format.js';

// Supply Closure Tracker — post-visit acquisition funnel synced from
// PROPERTIES_DB.cp_inventory_status. Reuses the inventory board scoped to the
// five supply stages. The CP sync runs in the BACKGROUND on load (the board
// renders current data immediately, then re-fetches once the sync finishes),
// and is also wired into the table's reload button (no separate sync button).
// The on-mount sync is throttled via sessionStorage so quick re-visits don't
// hammer the CP database; the reload button always syncs.
const SYNC_AT_KEY = 'di_supply_sync_at';
const SYNC_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export default function SupplyClosureTracker() {
  const [reloadSignal, setReloadSignal] = useState(0);
  const ran = useRef(false);

  const sync = useCallback(
    () => api.post('/api/inventory/supply-sync', {}).then((res) => {
      sessionStorage.setItem(SYNC_AT_KEY, String(Date.now()));
      return res;
    }),
    []
  );

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const last = Number(sessionStorage.getItem(SYNC_AT_KEY));
    if (last && Date.now() - last < SYNC_MAX_AGE_MS) return; // synced recently — skip
    sync()
      .then(() => setReloadSignal((n) => n + 1)) // refresh board with fresh data
      .catch(() => { /* non-blocking — current data still shows */ });
  }, [sync]);

  return (
    <div>
      <InventoryBoard
        fixedStages={SUPPLY_STAGES}
        showAdd={false}
        allowStatusEdit={false}
        reasonFilter
        hideFollowUpFilter
        reasonOptions={ALL_SUPPLY_REASONS}
        reloadSignal={reloadSignal}
        onReload={sync}
        showReasonCol
      />
    </div>
  );
}
