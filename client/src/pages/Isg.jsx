import { useEffect, useState } from 'react';
import { api } from '../api';
import Modal from '../components/Modal';
import { fmtDate, today, useProjects, ProjectBar } from '../utils';

const INCIDENT_TR = { ramak_kala: 'Ramak Kala', kaza: 'Kaza' };
const SEVERITY_TR = { hafif: 'Hafif', orta: 'Orta', agir: 'Ağır' };

export default function Isg() {
  const { projects, projectId, setProjectId } = useProjects();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [modal, setModal] = useState(null); // 'training' | 'incident' | 'cert' | null
  const [form, setForm] = useState({});

  async function load() {
    if (projectId == null) return;
    setBusy(true);
    try {
      setData(await api.get(`/api/isg/summary?project_id=${projectId}`));
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function open(kind) {
    setForm(
      kind === 'training'
        ? { topic: '', attendees: 0, training_date: today(), notes: '' }
        : kind === 'incident'
          ? { incident_type: 'ramak_kala', severity: 'hafif', incident_date: today(), description: '', root_cause: '', actions: '' }
          : { person_name: '', cert_type: 'Yüksekte Çalışma', issue_date: '', expiry_date: '', notes: '' }
    );
    setModal(kind);
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const path = modal === 'training' ? '/trainings' : modal === 'incident' ? '/incidents' : '/certifications';
      await api.post(`/api/isg${path}`, { ...form, project_id: projectId });
      setModal(null);
      await load();
      setMsg({ type: 'ok', text: 'Kaydedildi.' });
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function remove(kind, id) {
    if (!window.confirm('Kayıt silinsin mi?')) return;
    try {
      const path = kind === 'training' ? '/trainings' : kind === 'incident' ? '/incidents' : '/certifications';
      await api.del(`/api/isg${path}/${id}`);
      await load();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  const w = data?.warnings || [];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>İSG</h1>
          <p className="sub">Toolbox eğitimleri, ramak kala / kaza kayıtları, personel sertifikaları</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-accent" onClick={() => open('training')} disabled={projectId == null}>
            + Eğitim
          </button>
          <button className="btn" onClick={() => open('incident')} disabled={projectId == null}>
            + Olay
          </button>
          <button className="btn" onClick={() => open('cert')} disabled={projectId == null}>
            + Sertifika
          </button>
        </div>
      </div>

      <ProjectBar projects={projects} projectId={projectId} onChange={setProjectId}>
        {data && (
          <span className="muted" style={{ fontSize: 12 }}>
            ({data.counts.trainings} eğitim · {data.counts.ramak_kala} ramak kala · {data.counts.kaza} kaza)
          </span>
        )}
      </ProjectBar>

      {msg && (
        <div className={msg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {w.length > 0 && (
        <div className="form-error" style={{ marginBottom: 14 }}>
          <b>Sertifika uyarısı:</b>{' '}
          {w
            .slice(0, 4)
            .map((c) =>
              c.days_left < 0
                ? `${c.person_name} — ${c.cert_type} (${Math.abs(c.days_left)} gün önce doldu)`
                : `${c.person_name} — ${c.cert_type} (${c.days_left} gün kaldı)`
            )
            .join(' · ')}
          {w.length > 4 ? ` · +${w.length - 4} kayıt daha` : ''}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Sertifikalar</h3>
          {(data?.certifications || []).length === 0 ? (
            <div className="empty">Sertifika kaydı yok.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Personel</th>
                    <th>Sertifika</th>
                    <th>Bitiş</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.certifications.map((c) => {
                    const wrn = w.find((x) => x.id === c.id);
                    return (
                      <tr key={c.id}>
                        <td style={{ fontWeight: 600 }}>{c.person_name}</td>
                        <td>{c.cert_type}</td>
                        <td style={{ color: wrn ? (wrn.days_left < 0 ? '#dc2626' : '#d97706') : undefined, fontWeight: wrn ? 700 : 400 }}>
                          {fmtDate(c.expiry_date)}
                        </td>
                        <td>
                          <button className="btn btn-sm btn-danger" onClick={() => remove('cert', c.id)}>
                            Sil
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Olaylar</h3>
          {(data?.incidents || []).length === 0 ? (
            <div className="empty">Ramak kala / kaza kaydı yok.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tarih</th>
                    <th>Tip</th>
                    <th>Açıklama</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.incidents.map((i) => (
                    <tr key={i.id}>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {fmtDate(i.incident_date)}
                      </td>
                      <td>
                        <span className={`badge ${i.incident_type === 'kaza' ? 'badge-red' : 'badge-amber'}`}>
                          {INCIDENT_TR[i.incident_type]} · {SEVERITY_TR[i.severity]}
                        </span>
                      </td>
                      <td className="muted">{i.description.slice(0, 60)}{i.description.length > 60 ? '…' : ''}</td>
                      <td>
                        <button className="btn btn-sm btn-danger" onClick={() => remove('incident', i.id)}>
                          Sil
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Toolbox Eğitimleri</h3>
          {(data?.trainings || []).length === 0 ? (
            <div className="empty">Eğitim kaydı yok.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tarih</th>
                    <th>Konu</th>
                    <th className="num">Katılım</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.trainings.map((t) => (
                    <tr key={t.id}>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {fmtDate(t.training_date)}
                      </td>
                      <td style={{ fontWeight: 600 }}>{t.topic}</td>
                      <td className="num">{t.attendees}</td>
                      <td>
                        <button className="btn btn-sm btn-danger" onClick={() => remove('training', t.id)}>
                          Sil
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {modal && (
        <Modal
          title={modal === 'training' ? 'Yeni Eğitim' : modal === 'incident' ? 'Yeni Olay Kaydı' : 'Yeni Sertifika'}
          onClose={() => setModal(null)}
        >
          <form onSubmit={save}>
            {modal === 'training' && (
              <>
                <div className="field">
                  <label>Konu</label>
                  <input value={form.topic} onChange={set('topic')} placeholder="Yüksekte çalışma, enerji altında çalışma…" required />
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Tarih</label>
                    <input type="date" value={form.training_date} onChange={set('training_date')} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Katılımcı Sayısı</label>
                    <input type="number" min="0" value={form.attendees} onChange={set('attendees')} />
                  </div>
                </div>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Not</label>
                  <input value={form.notes} onChange={set('notes')} />
                </div>
              </>
            )}
            {modal === 'incident' && (
              <>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Tip</label>
                    <select value={form.incident_type} onChange={set('incident_type')}>
                      <option value="ramak_kala">Ramak Kala</option>
                      <option value="kaza">Kaza</option>
                    </select>
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Şiddet</label>
                    <select value={form.severity} onChange={set('severity')}>
                      <option value="hafif">Hafif</option>
                      <option value="orta">Orta</option>
                      <option value="agir">Ağır</option>
                    </select>
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Tarih</label>
                    <input type="date" value={form.incident_date} onChange={set('incident_date')} />
                  </div>
                </div>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Açıklama</label>
                  <textarea rows={3} value={form.description} onChange={set('description')} required />
                </div>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Kök Neden</label>
                  <input value={form.root_cause} onChange={set('root_cause')} />
                </div>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Alınan Önlemler</label>
                  <input value={form.actions} onChange={set('actions')} />
                </div>
              </>
            )}
            {modal === 'cert' && (
              <>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Personel</label>
                    <input value={form.person_name} onChange={set('person_name')} required />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Sertifika Türü</label>
                    <select value={form.cert_type} onChange={set('cert_type')}>
                      {['Yüksekte Çalışma', 'Enerji Altında Çalışma', 'İlk Yardım', 'Yangın Eğitimi', 'İş Makinesi Operatörlüğü'].map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Veriliş</label>
                    <input type="date" value={form.issue_date} onChange={set('issue_date')} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Bitiş</label>
                    <input type="date" value={form.expiry_date} onChange={set('expiry_date')} />
                  </div>
                </div>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Not</label>
                  <input value={form.notes} onChange={set('notes')} />
                </div>
              </>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button type="button" className="btn" onClick={() => setModal(null)}>
                Vazgeç
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Kaydet
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
