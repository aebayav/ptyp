import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtMoney, fmtDate, StatusBadge, QUOTE_STATUS } from '../utils';
import Modal from '../components/Modal';
import SupplierQuoteForm from '../components/SupplierQuoteForm';

// Satıcı görünümü: kendi tekliflerinin listesi (düzenle/sil, seçilmişse kilitli)
export default function SupplierQuotes() {
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null); // { quote }

  async function load() {
    try {
      setError(null);
      setQuotes(await api.get('/api/quotes'));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function submitEdit(quote, payload) {
    await api.put(`/api/quotes/${quote.id}`, { material_id: quote.material_id, ...payload });
    setModal(null);
    await load();
  }

  async function remove(quote) {
    const ok = window.confirm(
      `"${quote.material_name}" için verdiğiniz teklif silinecek. Emin misiniz?`
    );
    if (!ok) return;
    try {
      await api.del(`/api/quotes/${quote.id}`);
      await load();
    } catch (e) {
      alert('Silme başarısız: ' + e.message);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>💰 Tekliflerim</h1>
          <p className="sub">Gönderdiğiniz teklifler ve durumları</p>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <span>Liste yüklenemedi: {error}</span>
          <button className="btn btn-sm" onClick={load}>Tekrar Dene</button>
        </div>
      )}

      {loading ? (
        <div className="empty"><span className="empty-ico">⏳</span>Yükleniyor…</div>
      ) : quotes.length === 0 ? (
        <div className="empty">
          <span className="empty-ico">💬</span>
          Henüz teklif göndermediniz.{' '}
          <a href="/malzemeler" style={{ fontWeight: 600 }}>Açık malzemelere göz atın →</a>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Malzeme</th>
                <th className="num">Fiyat</th>
                <th className="num">Teslim</th>
                <th>Geçerlilik</th>
                <th>Durum</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{q.material_name}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{q.material_code}</div>
                  </td>
                  <td className="num" style={{ fontWeight: 700 }}>{fmtMoney(q.price, q.currency)}</td>
                  <td className="num">{q.delivery_days != null ? `${q.delivery_days} gün` : '—'}</td>
                  <td className="muted">{fmtDate(q.validity_date)}</td>
                  <td><StatusBadge meta={QUOTE_STATUS[q.status]} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {q.status === 'selected' ? (
                      <span className="muted" title="Seçilmiş teklif değiştirilemez">🎉 Kazandınız — kilitli</span>
                    ) : (
                      <>
                        <button className="icon-btn" title="Düzenle" onClick={() => setModal({ quote: q })}>✏️</button>
                        <button className="icon-btn" title="Sil" onClick={() => remove(q)}>🗑️</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal title={`Teklifi Güncelle — ${modal.quote.material_name}`} onClose={() => setModal(null)}>
          <SupplierQuoteForm
            initial={modal.quote}
            onCancel={() => setModal(null)}
            onSubmit={(payload) => submitEdit(modal.quote, payload)}
          />
        </Modal>
      )}
    </div>
  );
}
