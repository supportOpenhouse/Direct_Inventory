import { createContext, useContext, useEffect, useState } from 'react';
import { api, setAuthToken } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

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
    setUser(r.user);
  }

  function logout() {
    localStorage.removeItem('di_token');
    setAuthToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, loginWithGoogle, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
