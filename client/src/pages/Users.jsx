import { useEffect, useState } from 'react';
import { api } from '../api';
import Modal from '../components/Modal';

const EMPTY_FORM = {
  username: '',
  display_name: '',
  password: '',
  role: 'supplier',
  supplier_id: '',
};

export default function Users() {
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null); // {mode:'new'|'edit', item?}
  const [resetModal, setResetModal] = useState(null); // user
  const [resetPassword, setResetPassword] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setError(null);
      const [u, s] = await Promise.all([api.get('/api/users'), api.get('/api/suppliers')]);
      setItems(u);
      setSuppliers(s);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openNew() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setModal({ mode: 'new' });
  }

  function openEdit(item) {
    setForm({
      username: item.username,
      display_name: item.display_name,
      password: '',
      role: item.role,
      supplier_id: item.supplier_id == null ? '' : String(item.supplier_id),
    });
    setFormError(null);
    setModal({ mode: 'edit', item });
  }

  function set(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const payload = { ...form, supplier_id: form.role === 'supplier' ? form.supplier_id : '' };
    try {
      if (modal.mode === 'new') await api.post('/api/users', payload);
      else await api.put(`/api/users/${modal.item.id}`, payload);
      setModal(null);
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(item) {
    const ok = window.confirm(`"${item.username}" kullanıcısı silinecek. Emin misiniz?`);
    if (!ok) return;
    try {
      await api.del(`/api/users/${item.id}`);
      await load();
    } catch (e) {
      alert('Silme başarısız: ' + e.message);
    }
  }

  async function submitReset(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api.post(`/api/users/${resetModal.id}/reset-password`, { password: resetPassword });
      setResetModal(null);
      setResetPassword('');
      alert('Şifre sıfırlandı.');
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Kullanıcılar</h1>
          <p className="sub">Portal erişim hesapları — iş sahibi ve satıcı rolleri</p>
        </div>
        <button className="btn btn-accent" onClick={openNew}>+ Yeni Kullanıcı</button>
      </div>

      {error && (
        <div className="error-banner">
          <span>Liste yüklenemedi: {error}</span>
          <button className="btn btn-sm" onClick={load}>Tekrar Dene</button>
        </div>
      )}

      {loading ? (
        <div className="empty"><span className="empty-ico"></span>Yükleniyor…</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Kullanıcı Adı</th>
                <th>Ad Soyad</th>
                <th>Rol</th>
                <th>Bağlı Satıcı</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 600 }}>{u.username}</td>
                  <td>{u.display_name || <span className="muted">—</span>}</td>
                  <td>
                    {u.role === 'owner' ? (
                      <span className="badge badge-blue">İş Sahibi</span>
                    ) : (
                      <span className="badge badge-amber">Satıcı</span>
                    )}
                  </td>
                  <td>{u.supplier_name || <span className="muted">—</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="icon-btn" title="Düzenle" onClick={() => openEdit(u)}></button>
                    <button className="icon-btn" title="Şifre Sıfırla" onClick={() => { setResetModal(u); setResetPassword(''); setFormError(null); }}></button>
                    <button className="icon-btn" title="Sil" onClick={() => remove(u)}></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal
          title={modal.mode === 'new' ? 'Yeni Kullanıcı' : `Kullanıcı Düzenle — ${modal.item.username}`}
          onClose={() => setModal(null)}
        >
          <form onSubmit={submit}>
            {formError && <div className="form-error">{formError}</div>}
            <div className="form-row">
              <div className="field">
                <label>Kullanıcı Adı *</label>
                <input value={form.username} onChange={set('username')} required autoFocus placeholder="örn: demir-enerji" />
              </div>
              <div className="field">
                <label>Ad Soyad</label>
                <input value={form.display_name} onChange={set('display_name')} placeholder="örn: Mehmet Demir" />
              </div>
            </div>
            <div className="field">
              <label>Şifre {modal.mode === 'edit' && <span className="muted">(boş bırakılırsa değişmez)</span>}</label>
              <input
                type="password"
                value={form.password}
                onChange={set('password')}
                required={modal.mode === 'new'}
                placeholder={modal.mode === 'new' ? 'En az 6 karakter' : 'Yeni şifre (opsiyonel)'}
              />
            </div>
            <div className="form-row">
              <div className="field">
                <label>Rol</label>
                <select value={form.role} onChange={set('role')}>
                  <option value="owner">İş Sahibi (tam yetki)</option>
                  <option value="supplier">Satıcı (sadece teklif)</option>
                </select>
              </div>
              {form.role === 'supplier' && (
                <div className="field">
                  <label>Bağlı Satıcı Firması *</label>
                  <select value={form.supplier_id} onChange={set('supplier_id')} required>
                    <option value="">Satıcı seçin…</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {form.role === 'supplier' && suppliers.length === 0 && (
              <div className="form-error">
                Henüz satıcı kaydı yok. Önce <strong>Satıcılar</strong> sayfasından firmayı ekleyin.
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setModal(null)}>Vazgeç</button>
              <button type="submit" className="btn btn-accent" disabled={saving}>
                {saving ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {resetModal && (
        <Modal title={`Şifre Sıfırla — ${resetModal.username}`} onClose={() => setResetModal(null)}>
          <form onSubmit={submitReset}>
            {formError && <div className="form-error">{formError}</div>}
            <div className="field">
              <label>Yeni Şifre</label>
              <input
                type="password"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                required
                minLength={6}
                autoFocus
                placeholder="En az 6 karakter"
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setResetModal(null)}>Vazgeç</button>
              <button type="submit" className="btn btn-accent" disabled={saving}>
                {saving ? 'Kaydediliyor…' : 'Sıfırla'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
