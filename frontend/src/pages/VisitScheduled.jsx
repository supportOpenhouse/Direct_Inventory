import InventoryBoard from '../components/InventoryBoard.jsx';

// "Visit Status" board — visit_scheduled + visit_cancelled leads, with stage
// pills (ALL / Visit Scheduled / Visit Cancelled). Stage editing is disabled.
export default function VisitScheduled() {
  return (
    <div>
      <InventoryBoard fixedStages={['visit_scheduled', 'visit_cancelled']} showAdd={false} allowStatusEdit={false} annotateVisitOverdue />
    </div>
  );
}
