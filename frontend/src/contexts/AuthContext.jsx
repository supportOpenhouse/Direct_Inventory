import { createContext, useContext, useEffect, useState } from 'react';
import { api, setAuthToken } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [transition, setTransition] = useState(null); // null | 'in' (sign-in) | 'out' (sign-out)
  const [tname, setTname] = useState('');             // name shown in the curtain greeting

  // Play the full-screen "grow" curtain. 1900ms must outlast the CSS animation
  // (~1.7s) in styles.css (.welcome-curtain).
  function runCurtain(kind, name) {
    setTname(name || '');
    setTransition(kind);
    setTimeout(() => setTransition(null), 1900);
  }

  // Sign in: start the curtain first, then flip the user ~once it has covered
  // the screen, so the gradient grows out of the real hero (no pop) and the
  // login -> dashboard route swap stays hidden behind the orange.
  function signIn(u) {
    runCurtain('in', u?.name);
    setTimeout(() => setUser(u), 650);
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
    runCurtain('out', user?.name);
    // Cover the dashboard first, then clear auth (which redirects to /login
    // behind the orange) so "Goodbye" plays over the dashboard, not the login.
    setTimeout(() => {
      localStorage.removeItem('di_token');
      localStorage.removeItem('di_mock_email');
      setAuthToken(null);
      setUser(null);
    }, 650);
  }

  return (
    <AuthContext.Provider value={{ user, loading, loginWithGoogle, loginAsDev, logout }}>
      {children}
      {transition && (
        <div className={`welcome-curtain ${transition}`} aria-hidden="true">
          {/* The orange gradient that grows to fill the screen. */}
          <div className="wc-grad">
            {/* Full hero, kept intact (same content/layout as the login screen). */}
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
            <div className="wc-greeting">
              <span className="wc-hi">{transition === 'out' ? 'Goodbye :(' : 'Welcome back,'}</span>
              <span className="wc-name">{tname ? tname.split(' ')[0] : ''}</span>
            </div>
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
