import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiDownload } from '../api';
import { CATEGORY_SUGGESTIONS, MATERIAL_STATUS, UNITS, fmtMoney, StatusBadge } from '../utils';
import Modal from '../components/Modal';

const EMPTY_FORM = {
  code: '',
  name: '',
  category: '',
  spec: '',
  unit: 'adet',
  quantity: '1',
  target_price: '',
  status: 'open',
  notes: '',
};

export default function Materials() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [modal, setModal] = useState(null); // null | {mode:'new'} | {mode:'edit', item}
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setError(null);
      const [list, cats] = await Promise.all([
        api.get('/api/materials'),
        api.get('/api/materials/categories'),
      ]);
      setItems(list);
      setCategories(cats);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const suggestions = useMemo(() => {
    const merged = new Set([...CATEGORY_SUGGESTIONS, ...categories]);
    return [...merged];
  }, [categories]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((m) => {
      if (catFilter && m.category !== catFilter) return false;
      if (!q) return true;
      return (
        m.code.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q)
      );
    });
  }, [items, search, catFilter]);

  function openNew() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setModal({ mode: 'new' });
  }

  function openEdit(item) {
    setForm({
      code: item.code,
      name: item.name,
      category: item.category,
      spec: item.spec,
      unit: item.unit,
      quantity: String(item.quantity ?? 1),
      target_price: item.target_price == null ? '' : String(item.target_price),
      status: item.status,
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
    const payload = {
      ...form,
      quantity: Number(form.quantity),
      target_price: form.target_price === '' ? null : Number(form.target_price),
    };
    try {
      if (modal.mode === 'new') {
        const created = await api.post('/api/materials', payload);
        setItems((prev) => [...prev, created]);
      } else {
        const updated = await api.put(`/api/materials/${modal.item.id}`, payload);
        setItems((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      }
      setModal(null);
      load(); // kategori listesi güncellenir
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(item) {
    const ok = window.confirm(
      `"${item.name}" malzemesi silinecek. Bu malzemeye ait tüm teklifler de silinir. Emin misiniz?`
    );
    if (!ok) return;
    try {
      await api.del(`/api/materials/${item.id}`);
      setItems((prev) => prev.filter((m) => m.id !== item.id));
    } catch (e) {
      alert('Silme başarısız: ' + e.message);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>📦 Malzeme Listesi</h1>
          <p className="sub">Proje malzemeleri ve tedarik durumu</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={() => apiDownload('/api/export/materials', 'ptyp-malzemeler.xlsx')}>⬇️ Excel</button>
          <button className="btn btn-accent" onClick={openNew}>＋ Yeni Malzeme</button>
        </div>
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
          placeholder="Kod, ad veya kategori ara…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
          <option value="">Tüm Kategoriler</option>
          {suggestions.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>
          {filtered.length} kayıt
        </span>
      </div>

      {loading ? (
        <div className="empty"><span className="empty-ico">⏳</span>Yükleniyor…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          <span className="empty-ico">📦</span>
          Henüz malzeme eklenmemiş. İlk malzemeyi ekleyerek teklif toplamaya başlayın.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Kod</th>
                <th>Malzeme</th>
                <th>Kategori</th>
                <th className="num">Miktar</th>
                <th className="num">Hedef Fiyat</th>
                <th className="num">Teklif</th>
                <th>Durum</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.id}>
                  <td className="muted">{m.code}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{m.name}</div>
                    {m.spec && <div className="muted" style={{ fontSize: 11.5, maxWidth: 260 }}>{m.spec}</div>}
                  </td>
                  <td>{m.category || <span className="muted">—</span>}</td>
                  <td className="num">{m.quantity} {m.unit}</td>
                  <td className="num">{fmtMoney(m.target_price)}</td>
                  <td className="num">
                    {m.quote_count > 0 ? (
                      <button
                        className="btn btn-sm"
                        onClick={() => navigate(`/teklifler?malzeme=${m.id}`)}
                        title="Teklifleri gör"
                      >
                        {m.quote_count} teklif 💬
                      </button>
                    ) : (
                      <span className="badge badge-amber">Teklif yok</span>
                    )}
                  </td>
                  <td><StatusBadge meta={MATERIAL_STATUS[m.status]} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="icon-btn" title="Düzenle" onClick={() => openEdit(m)}>✏️</button>
                    <button className="icon-btn" title="Sil" onClick={() => remove(m)}>🗑️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal
          title={modal.mode === 'new' ? 'Yeni Malzeme' : `Malzeme Düzenle — ${modal.item.code}`}
          onClose={() => setModal(null)}
        >
          <form onSubmit={submit}>
            {formError && <div className="form-error">{formError}</div>}
            <div className="form-row">
              <div className="field">
                <label>Malzeme Kodu</label>
                <input value={form.code} onChange={set('code')} placeholder="Boş bırakılırsa otomatik" />
                <div className="form-hint">Örn: M-001 (boş → otomatik atanır)</div>
              </div>
              <div className="field">
                <label>Malzeme Adı *</label>
                <input value={form.name} onChange={set('name')} required autoFocus placeholder="Örn: 154 kV Güç Trafosu 50 MVA" />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Kategori</label>
                <input value={form.category} onChange={set('category')} list="cat-suggestions" placeholder="Seç veya yaz" />
                <datalist id="cat-suggestions">
                  {suggestions.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>
              <div className="field">
                <label>Durum</label>
                <select value={form.status} onChange={set('status')}>
                  {Object.entries(MATERIAL_STATUS).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Miktar</label>
                <input type="number" min="0" step="any" value={form.quantity} onChange={set('quantity')} />
              </div>
              <div className="field">
                <label>Birim</label>
                <select value={form.unit} onChange={set('unit')}>
                  {UNITS.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Hedef / Bütçe Fiyatı</label>
                <input type="number" min="0" step="any" value={form.target_price} onChange={set('target_price')} placeholder="Opsiyonel" />
                <div className="form-hint">Teklif karşılaştırmasında bütçe farkı için kullanılır</div>
              </div>
              <div className="field">
                <label>Notlar</label>
                <input value={form.notes} onChange={set('notes')} placeholder="Opsiyonel" />
              </div>
            </div>
            <div className="field">
              <label>Teknik Özellik</label>
              <textarea value={form.spec} onChange={set('spec')} placeholder="Gerilim seviyesi, malzeme tipi, standart vb." />
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
