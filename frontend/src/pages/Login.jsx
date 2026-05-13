import { useState } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function Login() {
  const { user, loginWithGoogle } = useAuth();
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

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <img src="/openhouse-logo.png" alt="Openhouse" className="login-logo" />
          <h1>Openhouse Direct Inventory</h1>
        </div>
        <p className="login-hint">Sign in with your <strong>@openhouse.in</strong> Google account.</p>
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
        {error && <div className="login-error">{error}</div>}
      </div>
    </div>
  );
}
