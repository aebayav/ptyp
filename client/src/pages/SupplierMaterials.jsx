import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { fmtMoney } from '../utils';
import Modal from '../components/Modal';
import SupplierQuoteForm from '../components/SupplierQuoteForm';

// Satıcı görünümü: yalnızca açık (open) malzemeler, yalnızca kendi teklifleri
export default function SupplierMaterials() {
  const [materials, setMaterials] = useState([]);
  const [myQuotes, setMyQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null); // { material, quote? }
  const [notice, setNotice] = useState(null);

  async function load() {
    try {
      setError(null);
      const [m, q] = await Promise.all([api.get('/api/materials'), api.get('/api/quotes')]);
      setMaterials(m);
      setMyQuotes(q);
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
    if (!q) return materials;
    return materials.filter(
      (m) =>
        m.code.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q)
    );
  }, [materials, search]);

  const quoteFor = (id) => myQuotes.find((q) => q.material_id === id);

  async function submitQuote(material, existing, payload) {
    const body = { material_id: material.id, ...payload };
    if (existing) await api.put(`/api/quotes/${existing.id}`, body);
    else await api.post('/api/quotes', body);
    setModal(null);
    setNotice(existing ? 'Teklifiniz güncellendi.' : `"${material.name}" için teklifiniz gönderildi. Teşekkürler!`);
    await load();
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Açık Malzemeler</h1>
          <p className="sub">Şu an teklif toplanan malzemeler — teklifinizi gönderin</p>
        </div>
      </div>

      {notice && (
        <div className="notice-banner">
          {notice}
        </div>
      )}

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
        <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>
          {filtered.length} açık malzeme
        </span>
      </div>

      {loading ? (
        <div className="empty"><span className="empty-ico"></span>Yükleniyor…</div>
      ) : materials.length === 0 ? (
        <div className="empty">
          <span className="empty-ico"></span>
          Şu anda teklif toplanan malzeme yok. Daha sonra tekrar kontrol edin.
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
                <th>Durum</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const mine = quoteFor(m.id);
                return (
                  <tr key={m.id}>
                    <td className="muted">{m.code}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{m.name}</div>
                      {m.spec && <div className="muted" style={{ fontSize: 11.5, maxWidth: 300 }}>{m.spec}</div>}
                    </td>
                    <td>{m.category || <span className="muted">—</span>}</td>
                    <td className="num">{m.quantity} {m.unit}</td>
                    <td><span className="badge badge-blue">Teklif Toplanıyor</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {mine ? (
                        <>
                          <span className="badge badge-green">Teklifiniz: {fmtMoney(mine.price, mine.currency)}</span>{' '}
                          <button className="btn btn-sm" onClick={() => setModal({ material: m, quote: mine })}>
                            Güncelle
                          </button>
                        </>
                      ) : (
                        <button className="btn btn-sm btn-accent" onClick={() => setModal({ material: m })}>
                          Teklif Ver
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal
          title={`${modal.quote ? 'Teklifi Güncelle' : 'Teklif Ver'} — ${modal.material.name}`}
          onClose={() => setModal(null)}
        >
          <SupplierQuoteForm
            initial={modal.quote}
            onCancel={() => setModal(null)}
            onSubmit={(payload) => submitQuote(modal.material, modal.quote, payload)}
          />
        </Modal>
      )}
    </div>
  );
}
