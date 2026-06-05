import InventoryBoard from '../components/InventoryBoard.jsx';

// Functional already: the board scoped to rejected leads. Stage pills are
// hidden since the stage is fixed; reject reasons surface in the expand panel.
export default function Rejected() {
  return (
    <div>
      <InventoryBoard fixedStages={['rejected']} showAdd={false} stageFilterable={false} reasonFilter hideFollowUpFilter showReasonCol />
    </div>
  );
}
