import { useState } from 'react';
import CreateTicketModal from './CreateTicketModal.jsx';
import { IconPlus } from './icons.jsx';

/**
 * Topbar action (Tickets page, admin/manager only) that opens the New Ticket
 * modal. Mirrors AddInventoryButton; CreateTicketModal fires `tickets:changed`
 * on success so the list/nav-dot refresh.
 */
export default function CreateTicketButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn-primary" onClick={() => setOpen(true)}><IconPlus size={16} /> New Ticket</button>
      {open && <CreateTicketModal onClose={() => setOpen(false)} />}
    </>
  );
}
