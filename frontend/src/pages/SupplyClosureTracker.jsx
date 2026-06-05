import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import InventoryBoard from '../components/InventoryBoard.jsx';
import { SUPPLY_STAGES, ALL_SUPPLY_REASONS } from '../utils/format.js';

// Supply Closure Tracker — post-visit acquisition funnel synced from
// PROPERTIES_DB.cp_inventory_status. Reuses the inventory board scoped to the
// five supply stages. The CP sync runs in the BACKGROUND on load (the board
// renders current data immediately, then re-fetches once the sync finishes),
// and is also wired into the table's reload button (no separate sync button).
export default function SupplyClosureTracker() {
  const [reloadSignal, setReloadSignal] = useState(0);
  const ran = useRef(false);

  const sync = useCallback(() => api.post('/api/inventory/supply-sync', {}), []);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
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
