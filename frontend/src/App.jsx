import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext.jsx';
import Login from './pages/Login.jsx';
import Board from './pages/Board.jsx';
import AdminUsers from './pages/AdminUsers.jsx';
import AdminActivity from './pages/AdminActivity.jsx';
import AdminUserReport from './pages/AdminUserReport.jsx';
import AdminUserReportDetail from './pages/AdminUserReportDetail.jsx';
import Layout from './components/Layout.jsx';

function RequireAuth({ children, role, roles }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  // `role` = single allowed role; `roles` = list. Admin always passes.
  const allowed = roles || (role ? [role] : null);
  if (allowed && !allowed.includes(user.role) && user.role !== 'admin') {
    return <Navigate to="/" replace />;
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route path="/" element={<Board />} />
        <Route
          path="/admin/users"
          element={<RequireAuth role="admin"><AdminUsers /></RequireAuth>}
        />
        {/* RM Mapping page removed — rm_mapping table retired (migration 016).
            To be rebuilt against the users table. */}
        <Route
          path="/admin/activity"
          element={<RequireAuth role="admin"><AdminActivity /></RequireAuth>}
        />
        {/* User Report — admin sees all users, manager sees only their RMs,
            RM sees only themselves. Backend enforces scope independently. */}
        <Route
          path="/admin/user-report"
          element={<RequireAuth><AdminUserReport /></RequireAuth>}
        />
        <Route
          path="/admin/user-report/detail"
          element={<RequireAuth><AdminUserReportDetail /></RequireAuth>}
        />
        {/* Self-service report — any role. The component locks the email to
            the logged-in user for non-admins. */}
        <Route
          path="/my-report"
          element={<RequireAuth><AdminUserReportDetail /></RequireAuth>}
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
