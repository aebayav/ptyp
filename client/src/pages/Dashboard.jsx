import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
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
          <h1>Genel bakış</h1>
        </div>
        <div className="error-banner">
          <span>Veriler yüklenemedi: {error}</span>
          <button className="btn btn-sm" onClick={load}>Tekrar dene</button>
        </div>
      </div>
    );
  }

  if (!overview) {
    return (
      <div>
        <div className="page-head"><h1>Genel bakış</h1></div>
        <div className="empty">Yükleniyor…</div>
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
          <h1>Genel bakış</h1>
          <p className="sub">ENH ve trafo projeleri genel durumu</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/portfoy" className="btn">Portföy</Link>
          <Link to="/malzemeler" className="btn btn-primary">
            <Plus size={16} strokeWidth={1.5} />
            <span>Yeni malzeme</span>
          </Link>
        </div>
      </div>

      <div className="grid-cards">
        <Link to="/is-takibi" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="stat-card">
            <div className="stat-label">Fiziki ilerleme</div>
            <div className="stat-value">%{overview.overallProgress ?? 0}</div>
            <div className="stat-meta">{overview.openTasks ?? 0} açık görev</div>
          </div>
        </Link>
        <Link to="/saha" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="stat-card accent">
            <div className="stat-label">Saha ilerlemesi</div>
            <div className="stat-value">%{overview.sahaProgress ?? 0}</div>
            <div className="stat-meta">{overview.sahaPoles ?? 0} direk</div>
          </div>
        </Link>
        <Link to="/teklifler" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="stat-card">
            <div className="stat-label">En iyi teklifler toplamı</div>
            <div className="stat-value">{fmtMoney(overview.bestTotal)}</div>
            <div className="stat-meta">{overview.quotes} teklif · {overview.withoutQuotes} teklifsiz</div>
          </div>
        </Link>
        <Link to="/malzemeler" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="stat-card">
            <div className="stat-label">Tedarik kapsamı</div>
            <div className="stat-value">{overview.materials}</div>
            <div className="stat-meta">malzeme · {overview.suppliers} satıcı</div>
          </div>
        </Link>
      </div>

      <div className="alert-strip">
        <Link to="/is-takibi" className={`alert-chip ${(overview.lateTasks ?? 0) > 0 ? 'warn' : ''}`}>
          <span className="alert-chip-label">
            <span className={`status-dot ${(overview.lateTasks ?? 0) > 0 ? 'warn' : ''}`} />
            <span>Geciken görev</span>
          </span>
          <strong>{overview.lateTasks ?? 0}</strong>
        </Link>
        <Link to="/teklifler" className={`alert-chip ${(overview.requested ?? 0) > 0 ? 'amber' : ''}`}>
          <span className="alert-chip-label">
            <span className={`status-dot ${(overview.requested ?? 0) > 0 ? 'amber' : ''}`} />
            <span>Bekleyen teklif</span>
          </span>
          <strong>{overview.requested ?? 0}</strong>
        </Link>
        <Link to="/saha" className={`alert-chip ${(overview.openSahaRequests ?? 0) > 0 ? 'amber' : ''}`}>
          <span className="alert-chip-label">
            <span className={`status-dot ${(overview.openSahaRequests ?? 0) > 0 ? 'amber' : ''}`} />
            <span>Saha talebi</span>
          </span>
          <strong>{overview.openSahaRequests ?? 0}</strong>
        </Link>
        <Link to="/kamulastirma" className={`alert-chip ${(overview.unpermittedParcels ?? 0) > 0 ? 'warn' : ''}`}>
          <span className="alert-chip-label">
            <span className={`status-dot ${(overview.unpermittedParcels ?? 0) > 0 ? 'warn' : ''}`} />
            <span>İzinsiz parsel</span>
          </span>
          <strong>{overview.unpermittedParcels ?? 0}</strong>
        </Link>
        <Link to="/isg" className={`alert-chip ${(overview.expiringCerts ?? 0) > 0 ? 'warn' : ''}`}>
          <span className="alert-chip-label">
            <span className={`status-dot ${(overview.expiringCerts ?? 0) > 0 ? 'warn' : ''}`} />
            <span>Yaklaşan sertifika</span>
          </span>
          <strong>{overview.expiringCerts ?? 0}</strong>
        </Link>
      </div>

      <div className="two-col">
        <div className="card">
          <h3>Son eklenen malzemeler</h3>
          {recentMaterials.length === 0 ? (
            <div className="empty">
              Henüz malzeme yok. <Link to="/malzemeler">Malzeme listesinden başlayın</Link>
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
                      <td className="muted mono">{m.code}</td>
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
          <h3>Bekleyen teklif talepleri</h3>
          {pendingQuotes.length === 0 ? (
            <div className="empty">Bekleyen teklif talebi yok</div>
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
                      <td className="muted mono">{fmtDate(q.created_at)}</td>
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
