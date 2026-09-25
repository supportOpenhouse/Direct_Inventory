import InventoryBoard from '../components/InventoryBoard.jsx';

// Qualified Leads = same board layout / columns as Follow Ups, scoped to the
// qualified stage. Stage pills are hidden — with one fixed stage, ALL and
// QUALIFIED are the same set.
export default function QualifiedLeads() {
  return (
    <div>
      <InventoryBoard showAdd={false} fixedStages={['qualified']} stageFilterable={false} />
    </div>
  );
}
