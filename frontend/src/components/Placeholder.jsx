// Polished "coming soon" page for sidebar entries whose flow isn't specified
// yet. Keeps the nav complete and signals intent.
export default function Placeholder({ icon = '🚧', title, children }) {
  return (
    <div className="placeholder">
      <div>
        <div className="ph-ic">{icon}</div>
        <h2>{title}</h2>
        <p>{children}</p>
        <div className="ph-tag"><span className="role-chip">Coming soon</span></div>
      </div>
    </div>
  );
}
