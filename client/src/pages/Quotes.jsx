import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { CURRENCIES, QUOTE_STATUS, fmtMoney, fmtDate, StatusBadge } from '../utils';
import Modal from '../components/Modal';

const EMPTY_FORM = {
  supplier_id: '',
  price: '',
  currency: 'TRY',
  delivery_days: '',
  validity_date: '',
  status: 'received',
  notes: '',
};

export default function Quotes() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [materials, setMaterials] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('manage');
  const [materialSearch, setMaterialSearch] = useState('');
  const [selId, setSelId] = useState(null);
  const [modal, setModal] = useState(null); // null | {mode:'new'} | {mode:'edit', quote}
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setError(null);
      const [m, s, q] = await Promise.all([
        api.get('/api/materials'),
        api.get('/api/suppliers'),
        api.get('/api/quotes'),
      ]);
      setMaterials(m);
      setSuppliers(s);
      setQuotes(q);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // URL'den malzeme seçimi
  useEffect(() => {
    const p = searchParams.get('malzeme');
    if (p) setSelId(Number(p));
  }, [searchParams]);

  function selectMaterial(id) {
    setSelId(id);
    setSearchParams({ malzeme: String(id) }, { replace: true });
  }

  const materialQuotes = useMemo(
    () => quotes.filter((q) => q.material_id === selId),
    [quotes, selId]
  );

  const selectedMaterial = useMemo(
    () => materials.find((m) => m.id === selId) || null,
    [materials, selId]
  );

  const filteredMaterials = useMemo(() => {
    const q = materialSearch.trim().toLowerCase();
    if (!q) return materials;
    return materials.filter(
      (m) => m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    );
  }, [materials, materialSearch]);

  // Her malzeme için en düşük teklif (sol panel ve özet için)
  const minByMaterial = useMemo(() => {
    const map = new Map();
    for (const q of quotes) {
      const cur = map.get(q.material_id);
      if (!cur || q.price < cur.price) map.set(q.material_id, q);
    }
    return map;
  }, [quotes]);

  const minPrice = materialQuotes.length ? Math.min(...materialQuotes.map((q) => q.price)) : null;
  const avgPrice = materialQuotes.length
    ? materialQuotes.reduce((s, q) => s + q.price, 0) / materialQuotes.length
    : null;

  // ---------- form ----------
  function openNew() {
    setForm({ ...EMPTY_FORM, supplier_id: suppliers.length ? String(suppliers[0].id) : '' });
    setFormError(null);
    setModal({ mode: 'new' });
  }

  function openEdit(q) {
    setForm({
      supplier_id: String(q.supplier_id),
      price: String(q.price),
      currency: q.currency,
      delivery_days: q.delivery_days == null ? '' : String(q.delivery_days),
      validity_date: q.validity_date || '',
      status: q.status,
      notes: q.notes || '',
    });
    setFormError(null);
    setModal({ mode: 'edit', quote: q });
  }

  function set(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const payload = {
      material_id: selId,
      supplier_id: Number(form.supplier_id),
      price: Number(form.price),
      currency: form.currency,
      delivery_days: form.delivery_days === '' ? null : Number(form.delivery_days),
      validity_date: form.validity_date,
      status: form.status,
      notes: form.notes,
    };
    try {
      if (modal.mode === 'new') {
        await api.post('/api/quotes', payload);
      } else {
        await api.put(`/api/quotes/${modal.quote.id}`, payload);
      }
      setModal(null);
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleSelect(q) {
    setBusy(true);
    try {
      if (q.status === 'selected') await api.post(`/api/quotes/${q.id}/unselect`);
      else await api.post(`/api/quotes/${q.id}/select`);
      await load();
    } catch (e) {
      alert('İşlem başarısız: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeQuote(q) {
    const ok = window.confirm(`${q.supplier_name} teklifi silinecek. Emin misiniz?`);
    if (!ok) return;
    try {
      await api.del(`/api/quotes/${q.id}`);
      await load();
    } catch (e) {
      alert('Silme başarısız: ' + e.message);
    }
  }

  // ---------- özet tablosu ----------
  const summaryRows = useMemo(() => {
    return materials.map((m) => {
      const mq = quotes.filter((q) => q.material_id === m.id);
      const best = minByMaterial.get(m.id);
      const diff =
        best && m.target_price != null ? best.price - m.target_price : null;
      return { m, count: mq.length, best, diff };
    });
  }, [materials, quotes, minByMaterial]);

  const summaryTotal = summaryRows.reduce((s, r) => s + (r.best ? r.best.price : 0), 0);

  if (error) {
    return (
      <div>
        <div className="page-head"><h1>💰 Teklif &amp; Karşılaştırma</h1></div>
        <div className="error-banner">
          <span>Veriler yüklenemedi: {error}</span>
          <button className="btn btn-sm" onClick={load}>Tekrar Dene</button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <div className="page-head"><h1>💰 Teklif &amp; Karşılaştırma</h1></div>
        <div className="empty"><span className="empty-ico">⏳</span>Yükleniyor…</div>
      </div>
    );
  }

  if (materials.length === 0) {
    return (
      <div>
        <div className="page-head"><h1>💰 Teklif &amp; Karşılaştırma</h1></div>
        <div className="empty">
          <span className="empty-ico">📦</span>
          Teklif toplamak için önce malzeme eklemelisiniz.{' '}
          <Link to="/malzemeler">Malzeme Listesi →</Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>💰 Teklif &amp; Karşılaştırma</h1>
          <p className="sub">Satıcılardan fiyat toplayın, en uygun teklifi seçin</p>
        </div>
      </div>

      <div className="tabs">
        <button className={tab === 'manage' ? 'active' : ''} onClick={() => setTab('manage')}>
          Teklif Yönetimi
        </button>
        <button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>
          Karşılaştırma Özeti
        </button>
      </div>

      {tab === 'manage' ? (
        <div className="quotes-layout">
          {/* --- Sol: malzeme listesi --- */}
          <div className="material-list">
            <div className="list-head">
              <input
                type="search"
                placeholder="Malzeme ara…"
                value={materialSearch}
                onChange={(e) => setMaterialSearch(e.target.value)}
              />
            </div>
            <div style={{ maxHeight: '62vh', overflowY: 'auto' }}>
              {filteredMaterials.map((m) => {
                const best = minByMaterial.get(m.id);
                const cnt = quotes.filter((q) => q.material_id === m.id).length;
                return (
                  <button
                    key={m.id}
                    className={`material-item ${m.id === selId ? 'active' : ''}`}
                    onClick={() => selectMaterial(m.id)}
                  >
                    <div className="mi-name">{m.name}</div>
                    <div className="mi-meta">
                      {m.code} · {cnt} teklif
                      {best && <> · en düşük {fmtMoney(best.price, best.currency)}</>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* --- Sağ: teklifler --- */}
          <div className="quote-panel">
            {!selectedMaterial ? (
              <div className="empty">
                <span className="empty-ico">👈</span>
                Soldan bir malzeme seçerek tekliflerini görün.
              </div>
            ) : (
              <>
                <div className="quote-panel-head">
                  <div>
                    <h2 style={{ fontSize: 17, marginBottom: 4 }}>
                      {selectedMaterial.name} <span className="muted" style={{ fontWeight: 400 }}>({selectedMaterial.code})</span>
                    </h2>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {selectedMaterial.category || 'Kategori yok'} · {selectedMaterial.quantity} {selectedMaterial.unit}
                      {selectedMaterial.target_price != null && (
                        <> · Hedef: <strong>{fmtMoney(selectedMaterial.target_price)}</strong></>
                      )}
                    </div>
                  </div>
                  <button className="btn btn-accent" onClick={openNew} disabled={suppliers.length === 0}>
                    ＋ Teklif Ekle
                  </button>
                </div>

                {suppliers.length === 0 && (
                  <div className="form-error">
                    Teklif ekleyebilmek için önce <Link to="/saticilar">satıcı</Link> kaydetmelisiniz.
                  </div>
                )}

                <div className="quote-stats">
                  <div>Teklif <strong>{materialQuotes.length}</strong></div>
                  <div>En Düşük <strong>{minPrice != null ? fmtMoney(minPrice, materialQuotes.find((q) => q.price === minPrice)?.currency) : '—'}</strong></div>
                  <div>Ortalama <strong>{avgPrice != null ? fmtMoney(avgPrice) : '—'}</strong></div>
                  {selectedMaterial.target_price != null && minPrice != null && (
                    <div>
                      Bütçeye Göre{' '}
                      <strong className={minPrice <= selectedMaterial.target_price ? 'diff-pos' : 'diff-neg'}>
                        {minPrice <= selectedMaterial.target_price ? '✓ ' : '▲ '}
                        {fmtMoney(selectedMaterial.target_price - minPrice)}
                      </strong>
                    </div>
                  )}
                </div>

                {materialQuotes.length === 0 ? (
                  <div className="empty">
                    <span className="empty-ico">💬</span>
                    Bu malzeme için henüz teklif yok. "Teklif Ekle" ile başlayın.
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Satıcı</th>
                          <th className="num">Fiyat</th>
                          <th className="num">Teslim</th>
                          <th>Geçerlilik</th>
                          <th>Durum</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {materialQuotes.map((q) => (
                          <tr key={q.id} className={q.price === minPrice && materialQuotes.length > 1 ? 'best' : ''}>
                            <td>
                              <div style={{ fontWeight: 600 }}>{q.supplier_name}</div>
                              {q.notes && <div className="muted" style={{ fontSize: 11.5, maxWidth: 220 }}>{q.notes}</div>}
                            </td>
                            <td className="num" style={{ fontWeight: 700, fontSize: 14.5 }}>
                              {fmtMoney(q.price, q.currency)}
                              {q.price === minPrice && materialQuotes.length > 1 && ' ⭐'}
                            </td>
                            <td className="num">{q.delivery_days != null ? `${q.delivery_days} gün` : '—'}</td>
                            <td className="muted">{fmtDate(q.validity_date)}</td>
                            <td><StatusBadge meta={QUOTE_STATUS[q.status]} /></td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              {q.status === 'selected' ? (
                                <button className="btn btn-sm btn-success" onClick={() => toggleSelect(q)} disabled={busy} title="Seçimi geri al">
                                  Seçili ✓
                                </button>
                              ) : (
                                <button className="btn btn-sm" onClick={() => toggleSelect(q)} disabled={busy} title="Bu teklifi seç">
                                  Seç
                                </button>
                              )}
                              <button className="icon-btn" title="Düzenle" onClick={() => openEdit(q)}>✏️</button>
                              <button className="icon-btn" title="Sil" onClick={() => removeQuote(q)}>🗑️</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        /* --- Karşılaştırma özeti --- */
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Kod</th>
                <th>Malzeme</th>
                <th>Kategori</th>
                <th className="num">Teklif</th>
                <th>En İyi Satıcı</th>
                <th className="num">En İyi Fiyat</th>
                <th className="num">Hedef</th>
                <th className="num">Fark</th>
              </tr>
            </thead>
            <tbody>
              {summaryRows.map(({ m, count, best, diff }) => (
                <tr key={m.id}>
                  <td className="muted">{m.code}</td>
                  <td style={{ fontWeight: 600 }}>{m.name}</td>
                  <td>{m.category || '—'}</td>
                  <td className="num">{count || <span className="badge badge-amber">yok</span>}</td>
                  <td>{best ? best.supplier_name : <span className="muted">—</span>}</td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {best ? fmtMoney(best.price, best.currency) : '—'}
                  </td>
                  <td className="num">{fmtMoney(m.target_price)}</td>
                  <td className="num">
                    {best && m.target_price != null ? (
                      <span className={diff <= 0 ? 'diff-pos' : 'diff-neg'}>
                        {diff <= 0 ? '' : '+'}
                        {fmtMoney(diff)}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="total-row">
                <td colSpan={5}>En İyi Teklifler Toplamı</td>
                <td className="num">{fmtMoney(summaryTotal)}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {modal && (
        <Modal
          title={modal.mode === 'new' ? `Yeni Teklif — ${selectedMaterial?.name || ''}` : 'Teklif Düzenle'}
          onClose={() => setModal(null)}
        >
          <form onSubmit={submit}>
            {formError && <div className="form-error">{formError}</div>}
            <div className="field">
              <label>Satıcı *</label>
              <select value={form.supplier_id} onChange={set('supplier_id')} required>
                <option value="">Satıcı seçin…</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Fiyat *</label>
                <input type="number" min="0" step="any" value={form.price} onChange={set('price')} required autoFocus placeholder="0,00" />
              </div>
              <div className="field">
                <label>Para Birimi</label>
                <select value={form.currency} onChange={set('currency')}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>{c === 'TRY' ? '₺ TRY' : c === 'USD' ? '$ USD' : '€ EUR'}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Teslim Süresi (gün)</label>
                <input type="number" min="0" value={form.delivery_days} onChange={set('delivery_days')} placeholder="Örn: 30" />
              </div>
              <div className="field">
                <label>Geçerlilik Tarihi</label>
                <input type="date" value={form.validity_date} onChange={set('validity_date')} />
              </div>
            </div>
            <div className="field">
              <label>Durum</label>
              <select value={form.status} onChange={set('status')}>
                {Object.entries(QUOTE_STATUS).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Not</label>
              <textarea value={form.notes} onChange={set('notes')} placeholder="Ödeme koşulu, nakliye dahil mi, iskonto vb." />
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
