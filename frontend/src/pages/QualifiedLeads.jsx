import InventoryBoard from '../components/InventoryBoard.jsx';

// Qualified Leads = same board layout / columns as Follow Ups, scoped to the
// qualified stage.
export default function QualifiedLeads() {
  return (
    <div>
      <InventoryBoard showAdd={false} fixedStages={['qualified']} />
    </div>
  );
}
