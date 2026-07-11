import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import Toaster from './components/Toaster.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import Leads from './pages/Leads.jsx';
import QualifiedLeads from './pages/QualifiedLeads.jsx';
import FollowUps from './pages/FollowUps.jsx';
import VisitScheduled from './pages/VisitScheduled.jsx';
import SupplyClosureTracker from './pages/SupplyClosureTracker.jsx';

// Low-traffic pages are code-split so they don't weigh down the main bundle.
const Rejected = lazy(() => import('./pages/Rejected.jsx'));
const Report = lazy(() => import('./pages/Report.jsx'));
const ReportDetail = lazy(() => import('./pages/ReportDetail.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const Logs = lazy(() => import('./pages/Logs.jsx'));
const TrackTasks = lazy(() => import('./pages/TrackTasks.jsx'));
const Tickets = lazy(() => import('./pages/Tickets.jsx'));
const MyProfile = lazy(() => import('./pages/MyProfile.jsx'));

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
    <>
      <Toaster />
      <Suspense fallback={<div className="loading">Loading…</div>}>
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
      </Suspense>
    </>
  );
}
