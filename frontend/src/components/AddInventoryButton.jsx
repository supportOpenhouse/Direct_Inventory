import { useState } from 'react';
import AddInventoryModal from './AddInventoryModal.jsx';
import { IconPlus } from './icons.jsx';

/**
 * Topbar action that opens the Add Inventory modal. Self-contained (like
 * CpScanButton): on success it fires a global `inventory:added` event so the
 * active list page can refetch — used by pages that own their own table
 * (e.g. Qualified Leads) rather than rendering InventoryBoard's own add button.
 */
export default function AddInventoryButton({ defaultStage = 'lead' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn-primary" onClick={() => setOpen(true)}><IconPlus size={16} /> Add Inventory</button>
      {open && (
        <AddInventoryModal
          defaultStage={defaultStage}
          onClose={() => setOpen(false)}
          onAdded={() => { setOpen(false); window.dispatchEvent(new CustomEvent('inventory:added', { detail: { stage: defaultStage } })); }}
        />
      )}
    </>
  );
}
