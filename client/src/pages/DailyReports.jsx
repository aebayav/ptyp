import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { fmtDate } from '../utils';
import Modal from '../components/Modal';

const WEATHER_LABELS = {
  '': '—',
  acik: '☀️ Açık',
  bulutlu: '⛅ Bulutlu',
  yagmurlu: '🌧️ Yağmurlu',
  firtina: '⛈️ Fırtına',
  kar: '❄️ Kar',
  sisli: '🌫️ Sisli',
};

const CREW_ROLES = {
  muhendis: 'Mühendis',
  tekniker: 'Tekniker / Sürveyan',
  usta: 'Usta / Formel',
  isci: 'İşçi',
  taseron: 'Taşeron',
  diger: 'Diğer',
};

const EQUIPMENT_TYPES = {
  vinc: 'Vinç',
  kepce: 'Kepçe / Ekskavatör',
  kamyon: 'Kamyon',
  jenerator: 'Jeneratör',
  kompressor: 'Kompresör',
  beton_pompasi: 'Beton Pompası',
  diger: 'Diğer',
};

const EMPTY_REPORT = {
  report_date: '',
  weather: 'acik',
  temperature: 20,
  work_summary: '',
  issues: '',
  crew: [],
  equipment: [],
};

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function DailyReports() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [modalMode, setModalMode] = useState(null); // 'new', 'edit', 'view'
  const [currentReport, setCurrentReport] = useState(null);
  const [form, setForm] = useState(EMPTY_REPORT);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function loadProjects() {
    try {
      const p = await api.get('/api/projects');
      setProjects(p);
      setProjectId((prev) => (p.some((x) => x.id === prev) ? prev : p[0]?.id ?? null));
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  }

  async function loadReports() {
    if (projectId == null) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const r = await api.get(`/api/daily-reports?project_id=${projectId}`);
      setReports(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    loadReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const todayReport = useMemo(() => reports.find(r => r.report_date === today()), [reports]);

  function openNew() {
    setForm({ ...EMPTY_REPORT, report_date: today() });
    setFormError(null);
    setModalMode('new');
  }

  async function openEdit(r, e) {
    e.stopPropagation();
    try {
      const data = await api.get(`/api/daily-reports/${r.id}`);
      setForm({
        id: data.id,
        report_date: data.report_date,
        weather: data.weather || '',
        temperature: data.temperature ?? '',
        work_summary: data.work_summary || '',
        issues: data.issues || '',
        crew: data.crew || [],
        equipment: data.equipment || [],
      });
      setFormError(null);
      setModalMode('edit');
    } catch (err) {
      alert('Rapor detayları alınamadı: ' + err.message);
    }
  }

  async function openView(r) {
    try {
      const data = await api.get(`/api/daily-reports/${r.id}`);
      setCurrentReport(data);
      setModalMode('view');
    } catch (err) {
      alert('Rapor detayları alınamadı: ' + err.message);
    }
  }

  async function remove(r, e) {
    e.stopPropagation();
    const ok = window.confirm(`${fmtDate(r.report_date)} tarihli rapor silinecek. Emin misiniz?`);
    if (!ok) return;
    try {
      await api.del(`/api/daily-reports/${r.id}`);
      await loadReports();
    } catch (err) {
      alert('Silme başarısız: ' + err.message);
    }
  }

  function setF(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  function handleCrewChange(index, field, value) {
    const newCrew = [...form.crew];
    newCrew[index] = { ...newCrew[index], [field]: value };
    setF('crew', newCrew);
  }

  function handleEqChange(index, field, value) {
    const newEq = [...form.equipment];
    newEq[index] = { ...newEq[index], [field]: value };
    setF('equipment', newEq);
  }

  async function submitForm(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);

    const payload = {
      project_id: projectId,
      report_date: form.report_date,
      weather: form.weather,
      temperature: Number(form.temperature),
      work_summary: form.work_summary,
      issues: form.issues,
      crew: form.crew.filter(c => Number(c.count) > 0),
      equipment: form.equipment.filter(eq => Number(eq.count) > 0),
    };

    try {
      if (modalMode === 'new') {
        await api.post('/api/daily-reports', payload);
      } else {
        await api.put(`/api/daily-reports/${form.id}`, payload);
      }
      setModalMode(null);
      await loadReports();
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
          <h1>📋 Saha Günlük Raporu</h1>
          <p className="sub">Proje bazlı günlük personel, ekipman ve imalat kaydı</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {projectId != null && (
            <button className="btn btn-accent" onClick={openNew}>＋ Yeni Rapor</button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>PROJE:</span>
        <select value={projectId ?? ''} onChange={(e) => setProjectId(Number(e.target.value))}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="error-banner">
          <span>Veriler yüklenemedi: {error}</span>
          <button className="btn btn-sm" onClick={loadReports}>Tekrar Dene</button>
        </div>
      )}

      {projectId != null && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 8 }}>Özet</h3>
          <div className="quote-stats" style={{ marginTop: 12, marginBottom: 0 }}>
            <div>Toplam Rapor <strong>{reports.length}</strong></div>
            <div>Bugünkü Personel <strong>{todayReport?.total_crew ?? 0}</strong></div>
            <div>Bugünkü Ekipman <strong>{todayReport?.total_equipment ?? 0}</strong></div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty"><span className="empty-ico">⏳</span>Yükleniyor…</div>
      ) : reports.length === 0 ? (
        <div className="empty">
          <span className="empty-ico">📋</span>
          Henüz rapor yok. İlk raporu ekleyin.
        </div>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Hava</th>
                <th className="num">Sıcaklık</th>
                <th className="num">Personel</th>
                <th className="num">Ekipman</th>
                <th>İmalat / Notlar</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => openView(r)}
                  style={{ cursor: 'pointer' }}
                  title="Detayları gör"
                >
                  <td style={{ fontWeight: 600 }}>{fmtDate(r.report_date)}</td>
                  <td>{WEATHER_LABELS[r.weather] || '—'}</td>
                  <td className="num">{r.temperature != null ? `${r.temperature} °C` : '—'}</td>
                  <td className="num"><span className="badge badge-blue">{r.total_crew}</span></td>
                  <td className="num"><span className="badge badge-gray">{r.total_equipment}</span></td>
                  <td className="muted" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.work_summary ? (r.work_summary.length > 60 ? r.work_summary.slice(0, 60) + '...' : r.work_summary) : '—'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="icon-btn" title="Düzenle" onClick={(e) => openEdit(r, e)}>✏️</button>
                    <button className="icon-btn" title="Sil" onClick={(e) => remove(r, e)}>🗑️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(modalMode === 'new' || modalMode === 'edit') && (
        <Modal
          title={modalMode === 'new' ? 'Yeni Rapor' : 'Rapor Düzenle'}
          onClose={() => setModalMode(null)}
        >
          <form onSubmit={submitForm}>
            {formError && <div className="form-error">{formError}</div>}
            
            <div className="form-row">
              <div className="field">
                <label>Tarih *</label>
                <input type="date" value={form.report_date} onChange={e => setF('report_date', e.target.value)} required />
              </div>
              <div className="field">
                <label>Hava Durumu</label>
                <select value={form.weather} onChange={e => setF('weather', e.target.value)}>
                  {Object.entries(WEATHER_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ maxWidth: 100 }}>
                <label>Sıcaklık (°C)</label>
                <input type="number" value={form.temperature} onChange={e => setF('temperature', e.target.value)} />
              </div>
            </div>

            <div style={{ marginTop: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong>👷 Personel (Puantaj)</strong>
                <button type="button" className="btn btn-sm" onClick={() => setF('crew', [...form.crew, { role: 'isci', company: '', count: 1 }])}>
                  ＋ Personel Ekle
                </button>
              </div>
              {form.crew.length === 0 ? (
                <div className="muted" style={{ fontSize: 12, paddingBottom: 10 }}>Henüz personel eklenmedi.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                  {form.crew.map((c, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select style={{ flex: 1 }} value={c.role} onChange={e => handleCrewChange(i, 'role', e.target.value)}>
                        {Object.entries(CREW_ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                      <input style={{ flex: 1 }} placeholder="Firma (Taşeron ise)" value={c.company} onChange={e => handleCrewChange(i, 'company', e.target.value)} disabled={c.role !== 'taseron'} />
                      <input style={{ width: 80 }} type="number" min="1" value={c.count} onChange={e => handleCrewChange(i, 'count', e.target.value)} placeholder="Sayı" />
                      <button type="button" className="icon-btn" onClick={() => setF('crew', form.crew.filter((_, idx) => idx !== i))}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginTop: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong>🚜 Ekipman & Araçlar</strong>
                <button type="button" className="btn btn-sm" onClick={() => setF('equipment', [...form.equipment, { equipment_type: 'kepce', description: '', count: 1 }])}>
                  ＋ Ekipman Ekle
                </button>
              </div>
              {form.equipment.length === 0 ? (
                <div className="muted" style={{ fontSize: 12, paddingBottom: 10 }}>Henüz ekipman eklenmedi.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                  {form.equipment.map((eq, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select style={{ flex: 1 }} value={eq.equipment_type} onChange={e => handleEqChange(i, 'equipment_type', e.target.value)}>
                        {Object.entries(EQUIPMENT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                      <input style={{ flex: 1 }} placeholder="Açıklama (Örn: Plaka)" value={eq.description} onChange={e => handleEqChange(i, 'description', e.target.value)} />
                      <input style={{ width: 80 }} type="number" min="1" value={eq.count} onChange={e => handleEqChange(i, 'count', e.target.value)} placeholder="Sayı" />
                      <button type="button" className="icon-btn" onClick={() => setF('equipment', form.equipment.filter((_, idx) => idx !== i))}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="field" style={{ marginTop: 16 }}>
              <label>Yapılan İşler (İmalat Özeti)</label>
              <textarea value={form.work_summary} onChange={e => setF('work_summary', e.target.value)} rows="4" placeholder="Bugün sahada neler yapıldı? Hangi kesimlerde çalışıldı?" />
            </div>

            <div className="field">
              <label>Sorunlar & Gecikmeler</label>
              <textarea value={form.issues} onChange={e => setF('issues', e.target.value)} rows="3" placeholder="Sahada karşılaşılan engeller (hava muhalefeti, arıza, malzeme eksiği vb.)" />
            </div>

            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setModalMode(null)}>Vazgeç</button>
              <button type="submit" className="btn btn-accent" disabled={saving}>
                {saving ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modalMode === 'view' && currentReport && (
        <Modal title={`${fmtDate(currentReport.report_date)} - Günlük Rapor`} onClose={() => setModalMode(null)}>
          <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
            <div><span className="muted">Hava:</span> {WEATHER_LABELS[currentReport.weather] || '—'}</div>
            <div><span className="muted">Sıcaklık:</span> {currentReport.temperature != null ? `${currentReport.temperature} °C` : '—'}</div>
          </div>

          <div style={{ display: 'flex', gap: 20, marginBottom: 20 }}>
            <div style={{ flex: 1 }}>
              <h4 style={{ marginBottom: 8, borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>👷 Personel</h4>
              {currentReport.crew?.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {currentReport.crew.map((c, i) => (
                    <li key={i}>
                      {c.count}x {CREW_ROLES[c.role] || c.role} 
                      {c.company && <span className="muted"> ({c.company})</span>}
                    </li>
                  ))}
                </ul>
              ) : <span className="muted">—</span>}
            </div>
            <div style={{ flex: 1 }}>
              <h4 style={{ marginBottom: 8, borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>🚜 Ekipman</h4>
              {currentReport.equipment?.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {currentReport.equipment.map((e, i) => (
                    <li key={i}>
                      {e.count}x {EQUIPMENT_TYPES[e.equipment_type] || e.equipment_type}
                      {e.description && <span className="muted"> ({e.description})</span>}
                    </li>
                  ))}
                </ul>
              ) : <span className="muted">—</span>}
            </div>
          </div>

          <h4 style={{ marginBottom: 8, borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>Yapılan İşler</h4>
          <div style={{ whiteSpace: 'pre-wrap', marginBottom: 20 }}>{currentReport.work_summary || <span className="muted">—</span>}</div>

          <h4 style={{ marginBottom: 8, borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>Sorunlar</h4>
          <div style={{ whiteSpace: 'pre-wrap', marginBottom: 20 }}>{currentReport.issues || <span className="muted">—</span>}</div>

          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setModalMode(null)}>Kapat</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
