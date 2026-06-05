import { useState } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { USING_MOCKS } from '../api/client.js';

const DEV_ACCOUNTS = [
  { email: 'admin@openhouse.in', name: 'Aarav Admin', role: 'Admin' },
  { email: 'manager@openhouse.in', name: 'Meera Manager', role: 'Manager' },
  { email: 'ravi@openhouse.in', name: 'Ravi Sharma', role: 'RM' },
];

export default function Login() {
  const { user, loginWithGoogle, loginAsDev } = useAuth();
  const [error, setError] = useState(null);
  const nav = useNavigate();

  if (user) return <Navigate to="/" replace />;

  async function handleSuccess(cred) {
    setError(null);
    try {
      await loginWithGoogle(cred.credential);
      nav('/');
    } catch (e) {
      setError(e.data?.error || e.message);
    }
  }

  async function dev(email) {
    setError(null);
    try { await loginAsDev(email); nav('/'); }
    catch (e) { setError(e.data?.error || e.message); }
  }

  return (
    <div className="login-page">
      <div className="login-hero">
        <div className="lh-brand">
          <img src="/openhouse-logo.png" alt="Openhouse" />
          <span>Openhouse</span>
        </div>
        <div>
          <h2>Direct Inventory, beautifully in order.</h2>
          <p className="lh-sub">
            Track leads from first listing to scheduled visit — qualify, follow up,
            and close, all in one place.
          </p>
        </div>
        <div className="lh-sub">Direct Inventory · Internal portal</div>
      </div>

      <div className="login-panel">
        <div className="login-card">
          <h1>Welcome back</h1>
          <p className="login-hint">
            Sign in with your <strong>@openhouse.in</strong> Google account.
          </p>

          <div className="login-google">
            <GoogleLogin
              onSuccess={handleSuccess}
              onError={() => setError('Google sign-in failed')}
              theme="filled_black"
              shape="pill"
              text="signin_with"
              useOneTap={false}
            />
          </div>

          {USING_MOCKS && (
            <>
              <div className="login-divider">or continue as (demo)</div>
              <div className="dev-grid">
                {DEV_ACCOUNTS.map((a) => (
                  <button key={a.email} type="button" className="dev-role-btn" onClick={() => dev(a.email)}>
                    <span>
                      <span className="drb-name">{a.name}</span>
                      <span className="drb-mail"> · {a.email}</span>
                    </span>
                    <span className="role-chip">{a.role}</span>
                  </button>
                ))}
              </div>
              <p className="login-mock-note">
                The backend isn't wired up yet, so the app is running on mock data.
                Pick a role above to explore. Set <code>VITE_USE_MOCKS=false</code> once
                the API is live.
              </p>
            </>
          )}

          {error && <div className="login-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
