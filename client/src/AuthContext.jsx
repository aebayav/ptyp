import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getCachedUser, getToken, isNetworkOrOfflineError, setCachedUser, setToken } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => (getToken() ? getCachedUser() : null));
  const [ready, setReady] = useState(false);

  // Sayfa açılışında kayıtlı token varsa oturumu doğrula; çevrimdışıysa yerel profili koru
  useEffect(() => {
    (async () => {
      if (!getToken()) {
        setReady(true);
        return;
      }
      try {
        const me = await api.get('/api/auth/me');
        setUser(me);
        setCachedUser(me);
      } catch (err) {
        const cached = getCachedUser();
        if (isNetworkOrOfflineError(err) && cached) {
          setUser(cached);
        } else {
          setToken(null);
          setUser(null);
        }
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const login = useCallback((token, u) => {
    setToken(token);
    setCachedUser(u);
    setUser(u);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setCachedUser(null);
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, ready, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
