import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import NotificationBell from './NotificationBell.jsx';

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
          <img src="/openhouse-logo.png" alt="Openhouse" className="brand-logo" />
          <span className="brand-sub">Direct Inventory</span>
        </div>
        <nav className="topnav">
          <NavLink to="/" end>Board</NavLink>
          {user?.role === 'admin' && <NavLink to="/admin/mapping">RM Mapping</NavLink>}
          {user?.role === 'admin' && <NavLink to="/admin/users">Users</NavLink>}
          {user?.role === 'admin' && <NavLink to="/admin/activity">Activity</NavLink>}
          {user?.role === 'admin' && <NavLink to="/admin/daily-report">Daily Report</NavLink>}
        </nav>
        <div className="user-pill">
          <NotificationBell role={user?.role} />
          <span className="role-chip">{user?.role}</span>
          <span className="user-name">{user?.name || user?.email}</span>
          <button className="btn-link" onClick={handleLogout}>Logout</button>
        </div>
      </header>
      <main className="main"><Outlet /></main>
    </div>
  );
}
