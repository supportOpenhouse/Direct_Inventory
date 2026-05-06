import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();

  function handleLogout() {
    logout();
    nav('/login');
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">OH</span>
          <span className="brand-name">Openhouse</span>
          <span className="brand-sub">Direct Inventory</span>
        </div>
        <nav className="topnav">
          <NavLink to="/" end>Board</NavLink>
          {user?.role === 'admin' && <NavLink to="/admin/mapping">RM Mapping</NavLink>}
          {user?.role === 'admin' && <NavLink to="/admin/users">Users</NavLink>}
          {user?.role === 'admin' && <NavLink to="/admin/activity">Activity</NavLink>}
        </nav>
        <div className="user-pill">
          <span className="role-chip">{user?.role}</span>
          <span className="user-name">{user?.name || user?.email}</span>
          <button className="btn-link" onClick={handleLogout}>Logout</button>
        </div>
      </header>
      <main className="main"><Outlet /></main>
    </div>
  );
}
