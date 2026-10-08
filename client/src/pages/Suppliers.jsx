import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

const EMPTY_FORM = {
  name: '',
  contact_name: '',
  phone: '',
  email: '',
  address: '',
  notes: '',
};

export default function Suppliers() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setError(null);
      setItems(await api.get('/api/suppliers'));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.contact_name.toLowerCase().includes(q) ||
        s.phone.toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q)
    );
  }, [items, search]);

  function openNew() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setModal({ mode: 'new' });
  }

  function openEdit(item) {
    setForm({
      name: item.name,
      contact_name: item.contact_name,
      phone: item.phone,
      email: item.email,
      address: item.address,
      notes: item.notes,
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
    try {
      if (modal.mode === 'new') {
        const created = await api.post('/api/suppliers', form);
        setItems((prev) => [...prev, created]);
      } else {
        const updated = await api.put(`/api/suppliers/${modal.item.id}`, form);
        setItems((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      }
      setModal(null);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(item) {
    const ok = window.confirm(
      `"${item.name}" satıcısı silinecek. Bu satıcıya ait tüm teklifler de silinir. Emin misiniz?`
    );
    if (!ok) return;
    try {
      await api.del(`/api/suppliers/${item.id}`);
      setItems((prev) => prev.filter((s) => s.id !== item.id));
    } catch (e) {
      alert('Silme başarısız: ' + e.message);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>🏢 Satıcılar</h1>
          <p className="sub">Fiyat teklifi alınan tedarikçi ve firmalar</p>
        </div>
        <button className="btn btn-accent" onClick={openNew}>＋ Yeni Satıcı</button>
      </div>

      {error && (
        <div className="error-banner">
          <span>Liste yüklenemedi: {error}</span>
          <button className="btn btn-sm" onClick={load}>Tekrar Dene</button>
        </div>
      )}

      <div className="toolbar">
        <input
          type="search"
          placeholder="Firma, yetkili, telefon veya e-posta ara…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>
          {filtered.length} kayıt
        </span>
      </div>

      {loading ? (
        <div className="empty"><span className="empty-ico">⏳</span>Yükleniyor…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          <span className="empty-ico">🏢</span>
          Henüz satıcı kaydedilmemiş. Teklif toplamadan önce satıcıları ekleyin.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Firma</th>
                <th>Yetkili</th>
                <th>Telefon</th>
                <th>E-posta</th>
                <th className="num">Teklif</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{s.name}</div>
                    {s.address && <div className="muted" style={{ fontSize: 11.5, maxWidth: 240 }}>{s.address}</div>}
                  </td>
                  <td>{s.contact_name || <span className="muted">—</span>}</td>
                  <td>{s.phone || <span className="muted">—</span>}</td>
                  <td>{s.email || <span className="muted">—</span>}</td>
                  <td className="num">{s.quote_count}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="icon-btn" title="Düzenle" onClick={() => openEdit(s)}>✏️</button>
                    <button className="icon-btn" title="Sil" onClick={() => remove(s)}>🗑️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal
          title={modal.mode === 'new' ? 'Yeni Satıcı' : `Satıcı Düzenle — ${modal.item.name}`}
          onClose={() => setModal(null)}
        >
          <form onSubmit={submit}>
            {formError && <div className="form-error">{formError}</div>}
            <div className="field">
              <label>Firma Adı *</label>
              <input value={form.name} onChange={set('name')} required autoFocus placeholder="Örn: Yüksek Gerilim Malzeme A.Ş." />
            </div>
            <div className="form-row">
              <div className="field">
                <label>Yetkili Kişi</label>
                <input value={form.contact_name} onChange={set('contact_name')} placeholder="Ad Soyad" />
              </div>
              <div className="field">
                <label>Telefon</label>
                <input value={form.phone} onChange={set('phone')} placeholder="0 (5xx) xxx xx xx" />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>E-posta</label>
                <input type="email" value={form.email} onChange={set('email')} placeholder="ornek@firma.com" />
              </div>
              <div className="field">
                <label>Adres</label>
                <input value={form.address} onChange={set('address')} placeholder="Opsiyonel" />
              </div>
            </div>
            <div className="field">
              <label>Notlar</label>
              <textarea value={form.notes} onChange={set('notes')} placeholder="Ödeme koşulları, uzmanlık alanları vb." />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setModal(null)}>Vazgeç</button>
              <button type="submit" className="btn btn-accent" disabled={saving}>
                {saving ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
