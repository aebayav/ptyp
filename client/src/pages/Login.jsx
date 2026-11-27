import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getApiBaseUrl, setApiBaseUrl } from '../api';
import { useAuth } from '../AuthContext';
import { PtypMark } from '../App';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showServerCfg, setShowServerCfg] = useState(false);
  const [serverUrl, setServerUrl] = useState(() => getApiBaseUrl());

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await api.post('/api/auth/login', { username, password });
      login(token, user);
      let after = null;
      try {
        after = sessionStorage.getItem('ptyp_after_login');
        sessionStorage.removeItem('ptyp_after_login');
      } catch {
        /* yok say */
      }
      navigate(
        after && after !== '/login'
          ? after
          : user.role === 'owner'
            ? '/'
            : user.role === 'field'
              ? '/saha'
              : '/malzemeler',
        { replace: true }
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="layout-login">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-brand-row">
            <PtypMark />
            <h1>PTYP</h1>
          </div>
          <p>ENH ve trafo merkezi proje yönetimi</p>
        </div>
        {error && <div className="form-error">{error}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label>Kullanıcı adı</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required autoComplete="username" />
          </div>
          <div className="field">
            <label>Şifre</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Giriş yapılıyor…' : 'Giriş yap'}
          </button>
        </form>
        <p className="auth-note">
          İş sahibi, saha ekibi ve satıcı hesapları aynı ekrandan giriş yapar ·{' '}
          <button
            type="button"
            onClick={() => setShowServerCfg((v) => !v)}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 12, textDecoration: 'underline' }}
          >
            Sunucu ayarı
          </button>
        </p>
        {showServerCfg && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: 'var(--soft-bg)', border: '1px solid var(--border)' }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 6, color: 'var(--text-secondary)' }}>
              Sunucu adresi (APK / uzak bağlantı)
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://turguz.app"
                style={{ flex: 1, height: 32, fontSize: 12.5, padding: '0 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text)' }}
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setApiBaseUrl(serverUrl);
                  setShowServerCfg(false);
                }}
              >
                Kaydet
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
