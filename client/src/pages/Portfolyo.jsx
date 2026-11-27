import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtMoney, fmtDate, useProjects } from '../utils';

// Portföy genel bakış: tüm projeler tek tabloda — ilerleme, saha, hakediş ve uyarılar.
// Satır sıralaması sunucudan gelir (uyarı çok → ilerleme yüksek).
export default function Portfolyo() {
  const { setProjectId } = useProjects();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      setError(null);
      setLoading(true);
      const d = await api.get('/api/overview/portfolio');
      setData(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (error) {
    return (
      <div>
        <div className="page-head">
          <h1>Portföy</h1>
        </div>
        <div className="error-banner">
          <span>Veriler yüklenemedi: {error}</span>
          <button className="btn btn-sm" onClick={load}>Tekrar Dene</button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <div className="page-head"><h1>Portföy</h1></div>
        <div className="card">
          <div className="empty"><span className="empty-ico"></span>{loading ? 'Yükleniyor…' : 'Veri bulunamadı.'}</div>
        </div>
      </div>
    );
  }

  const { projects, totals } = data;

  const goProject = (id) => () => setProjectId(id);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Portföy</h1>
          <p className="sub">Firmanın tüm projeleri — ilerleme, hakediş ve uyarılar tek bakışta</p>
        </div>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? 'Yenileniyor…' : '🔄 Yenile'}
        </button>
      </div>

      <div className="grid-cards">
        <div className="stat-card">
          <div className="stat-value">{totals.project_count}</div>
          <div className="stat-label">Toplam Proje</div>
        </div>
        <div className="stat-card accent">
          <div className="stat-value">%{totals.firm_progress ?? 0}</div>
          <div className="progress-track mini" style={{ marginTop: 8, marginBottom: 4 }}>
            <div className="progress-fill" style={{ width: `${totals.firm_progress ?? 0}%` }} />
          </div>
          <div className="stat-label">Firma İlerlemesi</div>
        </div>
        <div className={`stat-card ${totals.projects_with_warnings > 0 ? 'warn' : ''}`}>
          <div className="stat-value">{totals.projects_with_warnings}</div>
          <div className="stat-label">Uyarılı Proje</div>
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="card">
          <div className="empty">
            <div>Henüz proje yok.</div>
            <div style={{ marginTop: 10 }}>
              <Link to="/is-takibi" className="btn btn-accent">İş Takibi'nden yeni proje oluşturun</Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Proje</th>
                <th style={{ width: 150 }}>İlerleme</th>
                <th style={{ width: 150 }}>Saha</th>
                <th style={{ width: 130 }}>Hakediş</th>
                <th>Uyarılar</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {[p.type === 'trafo' ? 'Trafo' : 'ENH', p.capacity, p.employer].filter(Boolean).join(' · ')}
                    </div>
                    {p.end_date ? (
                      <div className="muted" style={{ fontSize: 12 }}>Bitiş: {fmtDate(p.end_date)}</div>
                    ) : null}
                  </td>
                  <td>
                    <Link
                      to="/is-takibi"
                      onClick={goProject(p.id)}
                      style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
                    >
                      <div style={{ fontWeight: 600 }}>{p.progress.toFixed(1)}%</div>
                      <div className="progress-track mini" style={{ marginTop: 4 }}>
                        <div className="progress-fill" style={{ width: `${p.progress}%` }} />
                      </div>
                    </Link>
                  </td>
                  <td>
                    {p.saha_poles > 0 ? (
                      <Link
                        to="/saha"
                        onClick={goProject(p.id)}
                        style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
                      >
                        <div style={{ fontWeight: 600 }}>{p.saha_progress.toFixed(1)}%</div>
                        <div className="progress-track mini" style={{ marginTop: 4 }}>
                          <div className="progress-fill" style={{ width: `${p.saha_progress}%` }} />
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>{p.saha_poles} direk</div>
                      </Link>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {(p.payments.draft > 0 || p.payments.submitted > 0 || p.payments.approved > 0) ? (
                      <Link
                        to="/hakedisler"
                        onClick={goProject(p.id)}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                      >
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {p.payments.draft > 0 && <span className="badge badge-amber">{p.payments.draft}T</span>}
                          {p.payments.submitted > 0 && <span className="badge badge-blue">{p.payments.submitted}O</span>}
                          {p.payments.approved > 0 && <span className="badge badge-green">{p.payments.approved}A</span>}
                        </div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{fmtMoney(p.payments.total_amount)}</div>
                      </Link>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {p.warning_count === 0 ? (
                      <span className="badge badge-green">Temiz</span>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {p.warnings.late_tasks > 0 && (
                          <Link to="/is-takibi" onClick={goProject(p.id)}>
                            <span className="badge badge-red">⚠ {p.warnings.late_tasks} gecikme</span>
                          </Link>
                        )}
                        {p.warnings.unpermitted_parcels > 0 && (
                          <Link to="/kamulastirma" onClick={goProject(p.id)}>
                            <span className="badge badge-red">⛔ {p.warnings.unpermitted_parcels} izinsiz</span>
                          </Link>
                        )}
                        {p.warnings.expiring_certs > 0 && (
                          <Link to="/isg" onClick={goProject(p.id)}>
                            <span className="badge badge-amber">🎓 {p.warnings.expiring_certs} sertifika</span>
                          </Link>
                        )}
                        {p.warnings.open_requests > 0 && (
                          <Link to="/depo" onClick={goProject(p.id)}>
                            <span className="badge badge-amber">📦 {p.warnings.open_requests} talep</span>
                          </Link>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
