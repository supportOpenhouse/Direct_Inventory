import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext.jsx';
import Login from './pages/Login.jsx';
import Board from './pages/Board.jsx';
import AdminUsers from './pages/AdminUsers.jsx';
import AdminMapping from './pages/AdminMapping.jsx';
import AdminActivity from './pages/AdminActivity.jsx';
import Layout from './components/Layout.jsx';

function RequireAuth({ children, role }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (role && user.role !== role && user.role !== 'admin') {
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
        <Route
          path="/admin/mapping"
          element={<RequireAuth role="admin"><AdminMapping /></RequireAuth>}
        />
        <Route
          path="/admin/activity"
          element={<RequireAuth role="admin"><AdminActivity /></RequireAuth>}
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
