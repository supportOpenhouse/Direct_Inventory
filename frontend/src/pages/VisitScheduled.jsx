import InventoryBoard from '../components/InventoryBoard.jsx';

// Board scoped to visit-scheduled leads. Same layout as Rejected, but stage
// editing is disabled here (the Edit Status button is hidden).
export default function VisitScheduled() {
  return (
    <div>
      <InventoryBoard fixedStages={['visit_scheduled']} showAdd={false} stageFilterable={false} allowStatusEdit={false} annotateVisitOverdue />
    </div>
  );
}
