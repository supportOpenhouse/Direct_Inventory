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
          <div className="wc-inner">
            <h1>Welcome <span>back</span></h1>
            <p>{user?.name ? `Good to see you, ${user.name.split(' ')[0]}` : 'Loading your dashboard…'}</p>
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
