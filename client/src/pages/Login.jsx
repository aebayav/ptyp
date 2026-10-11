import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../AuthContext';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await api.post('/api/auth/login', { username, password });
      login(token, user);
      navigate(user.role === 'owner' ? '/' : '/malzemeler', { replace: true });
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
        <p className="auth-note">İş sahibi ve satıcı hesapları aynı portaldan giriş yapar</p>
      </div>
    </div>
  );
}
