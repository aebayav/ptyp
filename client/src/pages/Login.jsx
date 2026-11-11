import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getApiBaseUrl, setApiBaseUrl } from '../api';
import { useAuth } from '../AuthContext';

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
      // QR/baglanti ile gelindiyse giriş sonrası asıl hedefe dön
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
          <span></span>
          <h1>PTYP</h1>
          <p>Elektrik Nakil Hattı &amp; Trafo Merkezi Projesi</p>
        </div>
        {error && <div className="form-error">{error}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label>Kullanıcı Adı</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required autoComplete="username" />
          </div>
          <div className="field">
            <label>Şifre</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Giriş yapılıyor…' : 'Giriş Yap'}
          </button>
        </form>
        <p className="auth-note">
          İş sahibi, saha ekibi ve satıcı hesapları aynı portaldan giriş yapar ·{' '}
          <button
            type="button"
            onClick={() => setShowServerCfg((v) => !v)}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 12, textDecoration: 'underline' }}
          >
            Sunucu Ayarı
          </button>
        </p>
        {showServerCfg && (
          <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'var(--soft-bg)', border: '1px solid var(--border)' }}>
            <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, marginBottom: 4 }}>
              Sunucu Adresi (Mobil APK / Uzak Bağlantı için)
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://turguz.app (boş = aynı sunucu)"
                style={{ flex: 1, fontSize: 12.5, padding: '6px 8px' }}
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
