import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import Leads from './pages/Leads.jsx';
import QualifiedLeads from './pages/QualifiedLeads.jsx';
import FollowUps from './pages/FollowUps.jsx';
import VisitScheduled from './pages/VisitScheduled.jsx';
import SupplyClosureTracker from './pages/SupplyClosureTracker.jsx';
import Rejected from './pages/Rejected.jsx';
import Report from './pages/Report.jsx';
import ReportDetail from './pages/ReportDetail.jsx';
import Users from './pages/Users.jsx';
import Logs from './pages/Logs.jsx';
import TrackTasks from './pages/TrackTasks.jsx';
import Tickets from './pages/Tickets.jsx';
import MyProfile from './pages/MyProfile.jsx';

function RequireAuth({ children, roles }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  // Admin always passes; otherwise the role must be in `roles`.
  if (roles && !roles.includes(user.role) && user.role !== 'admin') {
    return <Navigate to="/" replace />;
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route path="/" element={<Home />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/qualified-leads" element={<QualifiedLeads />} />
        <Route path="/follow-ups" element={<FollowUps />} />
        <Route path="/visit-scheduled" element={<VisitScheduled />} />
        <Route path="/pipeline" element={<SupplyClosureTracker />} />
        <Route path="/post-token" element={<Navigate to="/pipeline" replace />} />
        <Route path="/rejected" element={<Rejected />} />
        <Route path="/tickets" element={<Tickets />} />
        {/* Report — admin/manager see all (scoped on the backend); RMs are
            redirected to their own report via the sidebar's "My Report". */}
        <Route path="/report" element={<RequireAuth roles={['manager']}><Report /></RequireAuth>} />
        <Route path="/report/detail" element={<ReportDetail />} />
        <Route path="/my-report" element={<ReportDetail />} />
        <Route path="/profile" element={<MyProfile />} />
        <Route path="/users" element={<RequireAuth roles={[]}><Users /></RequireAuth>} />
        <Route path="/logs" element={<RequireAuth roles={[]}><Logs /></RequireAuth>} />
        <Route path="/track-tasks" element={<RequireAuth roles={[]}><TrackTasks /></RequireAuth>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
