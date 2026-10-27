import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtDate, useProjects, ProjectBar } from '../utils';

const W = 820;
const H = 300;
const PAD = { l: 46, r: 16, t: 18, b: 30 };

export default function Planlama() {
  const { projects, projectId, setProjectId } = useProjects();
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  function loadPlanning(pid = projectId) {
    if (pid == null) return Promise.resolve();
    return api
      .get(`/api/planning?project_id=${pid}`)
      .then(setData)
      .catch((e) => setMsg({ type: 'err', text: e.message }));
  }

  useEffect(() => {
    if (projectId == null) return;
    loadPlanning(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleQuickGenerate() {
    if (projectId == null) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.post('/api/workgroups/auto-generate', {
        project_id: projectId,
        mode: 'hybrid',
        replace_existing: true,
      });
      await loadPlanning(projectId);
      setMsg({
        type: 'ok',
        text: `Otomatik iş planı oluşturuldu (${res.created_groups} iş grubu, ${res.created_tasks} görev) ve S-eğrisi güncellendi.`,
      });
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncSaha() {
    if (projectId == null) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.post('/api/workgroups/sync-saha', { project_id: projectId });
      await loadPlanning(projectId);
      setMsg({
        type: 'ok',
        text:
          res.updated > 0
            ? `${res.updated} iş grubunun ilerlemesi saha direk durumlarından güncellendi.`
            : 'Tüm iş grupları güncel saha ilerlemesiyle zaten uyumlu.',
      });
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const chart = useMemo(() => {
    if (!data?.curve?.dates?.length) return null;
    const { dates, planned, actual } = data.curve;
    const n = dates.length;
    const x = (i) => PAD.l + ((W - PAD.l - PAD.r) * i) / Math.max(1, n - 1);
    const y = (v) => PAD.t + ((H - PAD.t - PAD.b) * (100 - v)) / 100;
    const pts = (arr) => arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const todayIdx = dates.indexOf(data.summary.today);
    return { x, y, plannedPts: pts(planned), actualPts: pts(actual), todayIdx, dates, planned, actual };
  }, [data]);

  const gantt = useMemo(() => {
    if (!data?.groups?.length) return null;
    const groups = data.groups.filter((g) => g.planned_start);
    if (!groups.length) return null;
    const min = groups.map((g) => g.planned_start).sort()[0];
    const max = [...groups.map((g) => g.planned_end || data.summary.today), data.summary.today].sort().pop();
    const total = Math.max(1, (new Date(max) - new Date(min)) / 86400000);
    const pos = (d) => ((new Date(d) - new Date(min)) / 86400000 / total) * 100;
    const todayPos = pos(data.summary.today);
    return { groups, min, max, pos, todayPos };
  }, [data]);

  if (!data) return null;

  const s = data.summary;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Plan &amp; Gerçekleşme</h1>
          <p className="sub">Ağırlıklı ilerlemeden otomatik S-eğrisi ve gecikme uyarısı</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={handleSyncSaha} disabled={busy}>
            🔄 Sahadan Güncelle
          </button>
          <Link to="/is-takibi" className="btn">
            İş Takibinde Düzenle
          </Link>
        </div>
      </div>

      <ProjectBar projects={projects} projectId={projectId} onChange={setProjectId} />

      {msg && (
        <div className={msg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {data.groups.length === 0 ? (
        <div className="card">
          <div className="empty">
            <div>Bu projede henüz ağırlıklı iş grubu veya takvim tanımlanmamış.</div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-accent" onClick={handleQuickGenerate} disabled={busy}>
                {busy ? 'Oluşturuluyor…' : '⚡ Otomatik İş Planı Oluştur'}
              </button>
              <Link to="/is-takibi" className="btn">
                İş Takibi Sayfasına Git
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <div className="card stat-card" style={{ flex: '1 1 150px', minWidth: 150 }}>
              <div className="stat-label">Gerçekleşen</div>
              <div className="stat-value">%{s.actual_pct}</div>
            </div>
            <div className="card stat-card" style={{ flex: '1 1 150px', minWidth: 150 }}>
              <div className="stat-label">Planlanan (bugün)</div>
              <div className="stat-value">%{s.planned_pct}</div>
            </div>
            <div className={`card stat-card ${s.behind_pct > 0 ? 'stat-warn' : ''}`} style={{ flex: '1 1 150px', minWidth: 150 }}>
              <div className="stat-label">Sapma</div>
              <div className="stat-value" style={{ color: s.behind_pct > 0 ? '#dc2626' : undefined }}>
                {s.behind_pct > 0 ? `−%${s.behind_pct}` : 'Zamanında'}
              </div>
            </div>
            <div className={`card stat-card ${s.late_groups > 0 ? 'stat-warn' : ''}`} style={{ flex: '1 1 150px', minWidth: 150 }}>
              <div className="stat-label">Geciken İş Grubu</div>
              <div className="stat-value">{s.late_groups}</div>
            </div>
          </div>

          {chart && (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>S-Eğrisi</h3>
              <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
                {[0, 25, 50, 75, 100].map((v) => (
                  <g key={v}>
                    <line x1={PAD.l} x2={W - PAD.r} y1={chart.y(v)} y2={chart.y(v)} stroke="var(--row-border)" strokeDasharray="3 4" />
                    <text x={PAD.l - 8} y={chart.y(v) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">
                      {v}%
                    </text>
                  </g>
                ))}
                {chart.todayIdx >= 0 && (
                  <g>
                    <line
                      x1={chart.x(chart.todayIdx)}
                      x2={chart.x(chart.todayIdx)}
                      y1={PAD.t}
                      y2={H - PAD.b}
                      stroke="#dc2626"
                      strokeDasharray="5 4"
                    />
                    <text x={chart.x(chart.todayIdx)} y={H - 12} textAnchor="middle" fontSize={10} fill="#dc2626">
                      Bugün
                    </text>
                  </g>
                )}
                <polyline points={chart.plannedPts} fill="none" stroke="#2563eb" strokeWidth={2.5} />
                <polyline points={chart.actualPts} fill="none" stroke="#16a34a" strokeWidth={2.5} />
                <text x={PAD.l} y={H - 12} fontSize={10} fill="var(--muted)">
                  {fmtDate(chart.dates[0])}
                </text>
                <text x={W - PAD.r} y={H - 12} textAnchor="end" fontSize={10} fill="var(--muted)">
                  {fmtDate(chart.dates[chart.dates.length - 1])}
                </text>
              </svg>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12.5 }}>
                <span>
                  <span style={{ display: 'inline-block', width: 12, height: 3, background: '#2563eb', verticalAlign: 'middle', marginRight: 5 }} />
                  Planlanan
                </span>
                <span>
                  <span style={{ display: 'inline-block', width: 12, height: 3, background: '#16a34a', verticalAlign: 'middle', marginRight: 5 }} />
                  Gerçekleşen
                </span>
              </div>
            </div>
          )}

          {gantt && (
            <div className="card" style={{ marginTop: 14 }}>
              <h3 style={{ marginTop: 0 }}>Gantt</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 120 }}>Grup</th>
                      <th style={{ width: '60%' }}>Zaman Çizelgesi</th>
                      <th className="num">İlerleme</th>
                      <th>Durum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gantt.groups.map((g) => (
                      <tr key={g.id}>
                        <td style={{ fontWeight: 600 }}>
                          {g.code}
                          <div className="muted" style={{ fontSize: 11 }}>
                            {g.name}
                          </div>
                        </td>
                        <td>
                          <div style={{ position: 'relative', height: 22, background: 'var(--soft-bg)', borderRadius: 6 }}>
                            <div
                              style={{
                                position: 'absolute',
                                top: 3,
                                height: 16,
                                left: `${gantt.pos(g.planned_start)}%`,
                                width: `${Math.max(3, gantt.pos(g.planned_end || s.today) - gantt.pos(g.planned_start))}%`,
                                background: g.late ? 'rgba(220,38,38,.15)' : 'rgba(37,99,235,.15)',
                                borderRadius: 4,
                                border: `1.5px solid ${g.late ? '#dc2626' : '#2563eb'}`,
                              }}
                            />
                            <div
                              style={{
                                position: 'absolute',
                                top: 5,
                                height: 12,
                                left: `${gantt.pos(g.planned_start)}%`,
                                width: `${Math.max(0, ((gantt.pos(g.planned_end || s.today) - gantt.pos(g.planned_start)) * Math.min(100, g.progress)) / 100)}%`,
                                background: g.late ? '#dc2626' : '#2563eb',
                                borderRadius: 3,
                                opacity: 0.85,
                              }}
                            />
                            {gantt.todayPos >= 0 && (
                              <div
                                style={{
                                  position: 'absolute',
                                  top: 0,
                                  bottom: 0,
                                  left: `${gantt.todayPos}%`,
                                  width: 1.5,
                                  background: '#dc2626',
                                  opacity: 0.6,
                                }}
                              />
                            )}
                          </div>
                        </td>
                        <td className="num">%{g.progress}</td>
                        <td>
                          {g.late ? (
                            <span className="badge badge-red">Gecikiyor · {g.delay_days} gün</span>
                          ) : g.progress >= 100 ? (
                            <span className="badge badge-green">Tamam</span>
                          ) : (
                            <span className="badge badge-blue">Sürüyor</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {s.late_groups > 0 && (
            <div className="form-error" style={{ marginTop: 14 }}>
              {s.late_groups} iş grubu planının gerisinde. En çok geride kalanlar:{' '}
              {data.groups
                .filter((g) => g.late)
                .sort((a, b) => b.behind_pct - a.behind_pct)
                .slice(0, 3)
                .map((g) => `${g.code} (−%${g.behind_pct})`)
                .join(' · ')}
            </div>
          )}
        </>
      )}
    </div>
  );
}
