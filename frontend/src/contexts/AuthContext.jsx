import { createContext, useContext, useEffect, useState } from 'react';
import { api, setAuthToken } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [welcome, setWelcome] = useState(false);

  // Set the user AND play the "Welcome back" wipe. Used only on explicit
  // sign-in (not silent token re-auth). The 1700ms must outlast the CSS
  // animation duration below in styles.css (.welcome-curtain).
  function signIn(u) {
    setUser(u);
    setWelcome(true);
    setTimeout(() => setWelcome(false), 1700);
  }

  useEffect(() => {
    const token = localStorage.getItem('di_token');
    if (!token) { setLoading(false); return; }
    setAuthToken(token);
    api.get('/api/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => {
        localStorage.removeItem('di_token');
        setAuthToken(null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function loginWithGoogle(idToken) {
    const r = await api.post('/api/auth/google', { id_token: idToken });
    localStorage.setItem('di_token', r.token);
    setAuthToken(r.token);
    signIn(r.user);
  }

  // Dev sign-in for the no-backend phase: pick a role and enter. Routes
  // through the mock /api/auth/dev endpoint.
  async function loginAsDev(email) {
    const r = await api.post('/api/auth/dev', { email });
    localStorage.setItem('di_token', r.token);
    setAuthToken(r.token);
    signIn(r.user);
  }

  function logout() {
    localStorage.removeItem('di_token');
    localStorage.removeItem('di_mock_email');
    setAuthToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, loginWithGoogle, loginAsDev, logout }}>
      {children}
      {welcome && (
        <div className="welcome-curtain" aria-hidden="true">
          {/* Full hero, kept intact (same content as the login screen). */}
          <div className="login-hero wc-hero">
            <div className="lh-brand">
              <img src="/openhouse-logo.png" alt="Openhouse" />
              <span>Openhouse</span>
            </div>
            <div>
              <h2>Direct Inventory Portal</h2>
              <p className="lh-sub">by Openhouse</p>
            </div>
            <div className="lh-sub">Direct Inventory · Internal portal</div>
          </div>
          {/* Right region: the greeting sits behind the white panel; the panel
              floats off first to reveal it, then the whole curtain slides off. */}
          <div className="wc-right">
            <div className="wc-greeting">
              <span className="wc-hi">Welcome back,</span>
              <span className="wc-name">{user?.name ? user.name.split(' ')[0] : ''}</span>
            </div>
            <div className="wc-white" />
          </div>
        </div>
      )}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
