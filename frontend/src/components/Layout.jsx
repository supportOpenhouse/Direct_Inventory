import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useTheme } from '../contexts/ThemeContext.jsx';
import NotificationBell from './NotificationBell.jsx';
import CpScanButton from './CpScanButton.jsx';
import ReassignLeadsButton from './ReassignLeadsButton.jsx';
import {
  IconHome, IconLeads, IconQualified, IconFollowUp, IconVisit, IconPipeline, IconRejected,
  IconReport, IconUsers, IconLogs, IconTasks, IconSun, IconMoon, IconMenu, IconLogout, IconChevron,
} from './icons.jsx';

const PRIMARY = [
  { to: '/', label: 'Home', Icon: IconHome, end: true },
  { to: '/leads', label: 'Leads', Icon: IconLeads },
  { to: '/qualified-leads', label: 'Qualified Leads', Icon: IconQualified },
  { to: '/follow-ups', label: 'Follow Ups', Icon: IconFollowUp },
  { to: '/visit-scheduled', label: 'Visit Scheduled', Icon: IconVisit },
  { to: '/pipeline', label: 'Supply Closure Tracker', Icon: IconPipeline },
  { to: '/rejected', label: 'Rejected', Icon: IconRejected },
];

const TITLES = {
  '': 'Home', leads: 'Leads', 'qualified-leads': 'Qualified Leads', 'follow-ups': 'Follow Ups', 'visit-scheduled': 'Visit Scheduled',
  pipeline: 'Supply Closure Tracker',
  'post-token': 'Post Token', rejected: 'Rejected', report: 'Report',
  'my-report': 'My Report', users: 'Users', logs: 'Activity Logs',
  'track-tasks': 'Track Tasks', profile: 'My Profile',
};

function initials(name, email) {
  const s = (name || (email || '').split('@')[0] || '').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase() || '?';
}

export default function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const nav = useNavigate();
  const loc = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('di_sidebar_collapsed') === '1');

  const isAdmin = user?.role === 'admin';
  const isManager = user?.role === 'manager';
  const seg = loc.pathname.split('/')[1] || '';
  const title = TITLES[seg] || 'Direct Inventory';

  function handleLogout() { logout(); nav('/login'); }
  function toggleCollapse() {
    setCollapsed((c) => { const n = !c; localStorage.setItem('di_sidebar_collapsed', n ? '1' : '0'); return n; });
  }

  const navItem = ({ to, label, Icon, end }) => (
    <NavLink key={to} to={to} end={end}
      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
      onClick={() => setMobileOpen(false)} title={collapsed ? label : undefined}>
      <span className="nav-ic"><Icon /></span>
      <span className="nav-label">{label}</span>
    </NavLink>
  );

  return (
    <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <img src="/openhouse-logo.png" alt="Openhouse" />
          <div className="brand-text">
            <div className="brand-name">Openhouse</div>
            <div className="brand-sub">Direct Inventory</div>
          </div>
        </div>

        <button className="sidebar-collapse-btn" onClick={toggleCollapse} title={collapsed ? 'Expand' : 'Collapse'} aria-label="Toggle sidebar">
          <span className="scb-chev"><IconChevron size={16} /></span>
          <span className="scb-label">Collapse</span>
        </button>

        {PRIMARY.map(navItem)}

        <div className="sidebar-section-label">Insights</div>
        {(isAdmin || isManager)
          ? navItem({ to: '/report', label: 'Report', Icon: IconReport })
          : navItem({ to: '/my-report', label: 'My Report', Icon: IconReport })}

        {isAdmin && (
          <>
            <div className="sidebar-section-label">Admin</div>
            {navItem({ to: '/track-tasks', label: 'Track Tasks', Icon: IconTasks })}
            {navItem({ to: '/users', label: 'Users', Icon: IconUsers })}
            {navItem({ to: '/logs', label: 'Logs', Icon: IconLogs })}
          </>
        )}

        <div className="nav-spacer" />
        <div className="sidebar-foot">
          <button type="button" className="sidebar-user" onClick={() => { nav('/profile'); setMobileOpen(false); }} title="My profile">
            <span className="avatar">{initials(user?.name, user?.email)}</span>
            <div className="su-text">
              <div className="su-name">{user?.name || user?.email}</div>
              <div className="su-role">{user?.role}</div>
            </div>
          </button>
        </div>
      </aside>

      {mobileOpen && <div className="modal-backdrop" style={{ zIndex: 400 }} onClick={() => setMobileOpen(false)} />}

      <div className="main-col">
        <header className="topbar">
          <button className="icon-btn topbar-menu" onClick={() => setMobileOpen(true)} aria-label="Menu"><IconMenu /></button>
          <h1>{title}</h1>
          <div className="topbar-spacer" />
          {(seg === '' || seg === 'leads') && <CpScanButton />}
          {seg === 'users' && isAdmin && <ReassignLeadsButton />}
          <NotificationBell role={user?.role} />
          <button className="icon-btn" onClick={toggle} aria-label="Toggle theme" title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}>
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
          <button className="icon-btn" onClick={handleLogout} aria-label="Logout" title="Logout"><IconLogout /></button>
        </header>
        <main className="main"><Outlet /></main>
      </div>
    </div>
  );
}
