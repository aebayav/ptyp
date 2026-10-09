import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtMoney, fmtDate, StatusBadge, MATERIAL_STATUS } from '../utils';

export default function Dashboard() {
  const [overview, setOverview] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [error, setError] = useState(null);

  async function load() {
    try {
      setError(null);
      const [o, m, q] = await Promise.all([
        api.get('/api/overview'),
        api.get('/api/materials'),
        api.get('/api/quotes'),
      ]);
      setOverview(o);
      setMaterials(m);
      setQuotes(q);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (error) {
    return (
      <div>
        <div className="page-head">
          <h1>📊 Genel Bakış</h1>
        </div>
        <div className="error-banner">
          <span>Veriler yüklenemedi: {error}</span>
          <button className="btn btn-sm" onClick={load}>Tekrar Dene</button>
        </div>
      </div>
    );
  }

  if (!overview) {
    return (
      <div>
        <div className="page-head"><h1>📊 Genel Bakış</h1></div>
        <div className="empty"><span className="empty-ico">⏳</span>Yükleniyor…</div>
      </div>
    );
  }

  const recentMaterials = [...materials]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 5);
  const pendingQuotes = quotes.filter((q) => q.status === 'requested').slice(0, 5);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>📊 Genel Bakış</h1>
          <p className="sub">Elektrik Nakil Hattı &amp; Trafo Merkezi Projesi — tedarik durumu</p>
        </div>
        <Link to="/malzemeler" className="btn btn-primary">＋ Yeni Malzeme</Link>
      </div>

      <div className="grid-cards">
        <div className="stat-card">
          <div className="stat-ico">📦</div>
          <div className="stat-value">{overview.materials}</div>
          <div className="stat-label">Toplam Malzeme</div>
        </div>
        <div className="stat-card">
          <div className="stat-ico">🏢</div>
          <div className="stat-value">{overview.suppliers}</div>
          <div className="stat-label">Kayıtlı Satıcı</div>
        </div>
        <div className="stat-card">
          <div className="stat-ico">💰</div>
          <div className="stat-value">{overview.quotes}</div>
          <div className="stat-label">Alınan Teklif</div>
        </div>
        <div className="stat-card warn">
          <div className="stat-ico">⏳</div>
          <div className="stat-value">{overview.requested}</div>
          <div className="stat-label">Bekleyen Teklif</div>
        </div>
      </div>

      <div className="grid-cards">
        <div className="stat-card accent">
          <div className="stat-ico">⭐</div>
          <div className="stat-value">{fmtMoney(overview.bestTotal)}</div>
          <div className="stat-label">En İyi Teklifler Toplamı (her malzemenin en düşük fiyatı)</div>
        </div>
        <div className="stat-card">
          <div className="stat-ico">🕳️</div>
          <div className="stat-value">{overview.withoutQuotes}</div>
          <div className="stat-label">Henüz Teklif Alınmamış Malzeme</div>
        </div>
        <Link to="/is-takibi" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="stat-card" style={{ cursor: 'pointer' }}>
            <div className="stat-ico">🔧</div>
            <div className="stat-value">%{overview.overallProgress ?? 0}</div>
            <div className="progress-track mini" style={{ marginTop: 8, marginBottom: 4 }}>
              <div className="progress-fill" style={{ width: `${overview.overallProgress ?? 0}%` }} />
            </div>
            <div className="stat-label">Genel Fiziki İlerleme</div>
          </div>
        </Link>
        <Link to="/is-takibi" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="stat-card warn" style={{ cursor: 'pointer' }}>
            <div className="stat-ico">⏰</div>
            <div className="stat-value">{overview.lateTasks ?? 0}</div>
            <div className="stat-label">Geciken Görev · {overview.openTasks ?? 0} açık</div>
          </div>
        </Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, flexWrap: 'wrap' }} className="two-col">
        <div className="card">
          <h3>🆕 Son Eklenen Malzemeler</h3>
          {recentMaterials.length === 0 ? (
            <div className="empty">
              <span className="empty-ico">📦</span>
              Henüz malzeme yok.{' '}
              <Link to="/malzemeler">Malzeme Listesi'nden başlayın →</Link>
            </div>
          ) : (
            <div className="table-wrap" style={{ border: 'none' }}>
              <table>
                <thead>
                  <tr><th>Kod</th><th>Malzeme</th><th>Durum</th><th className="num">Hedef</th></tr>
                </thead>
                <tbody>
                  {recentMaterials.map((m) => (
                    <tr key={m.id}>
                      <td className="muted">{m.code}</td>
                      <td>{m.name}</td>
                      <td>
                        <StatusBadge meta={MATERIAL_STATUS[m.status]} />
                      </td>
                      <td className="num">{fmtMoney(m.target_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3>⏳ Bekleyen Teklif Talepleri</h3>
          {pendingQuotes.length === 0 ? (
            <div className="empty">
              <span className="empty-ico">✅</span>
              Bekleyen teklif talebi yok.
            </div>
          ) : (
            <div className="table-wrap" style={{ border: 'none' }}>
              <table>
                <thead>
                  <tr><th>Malzeme</th><th>Satıcı</th><th>Tarih</th></tr>
                </thead>
                <tbody>
                  {pendingQuotes.map((q) => (
                    <tr key={q.id}>
                      <td>{q.material_name}</td>
                      <td className="muted">{q.supplier_name}</td>
                      <td className="muted">{fmtDate(q.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
