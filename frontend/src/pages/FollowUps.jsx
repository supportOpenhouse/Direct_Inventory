import InventoryBoard from '../components/InventoryBoard.jsx';

// Follow Ups = same board layout as Pipeline, scoped to Call Not Received and
// Follow Up leads.
export default function FollowUps() {
  return (
    <div>
      <InventoryBoard showAdd={false} fixedStages={['call_not_received', 'follow_up']} />
    </div>
  );
}
