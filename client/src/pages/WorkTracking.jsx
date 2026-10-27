import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiDownload } from '../api';
import { fmtDate, today, useProjects, StatusBadge } from '../utils';
import Modal from '../components/Modal';
import RouteMap from './RouteMap';

const GROUP_STATUS = {
  pending: { label: 'Başlamadı', cls: 'badge-gray' },
  active: { label: 'Devam Ediyor', cls: 'badge-blue' },
  completed: { label: 'Tamamlandı', cls: 'badge-green' },
};

const TASK_STATUS = {
  todo: { label: 'Yapılacak', cls: 'badge-gray' },
  in_progress: { label: 'Devam Ediyor', cls: 'badge-blue' },
  done: { label: 'Tamamlandı', cls: 'badge-green' },
};

const PRIORITY = {
  low: { label: 'Düşük', cls: 'badge-gray' },
  normal: { label: 'Normal', cls: 'badge-blue' },
  high: { label: 'Yüksek', cls: 'badge-amber' },
};

const SAHA_STAGE_LABELS = {
  '': 'Genel Ortalama',
  all: 'Genel Ortalama',
  excavation: 'Kazı',
  foundation: 'Temel',
  erection: 'Direk Montajı',
  fittings: 'Donanım/İzolatör',
  stringing: 'İletken Çekimi',
  completed: 'Kabul/Tamam',
};

const EMPTY_GROUP = {
  code: '',
  name: '',
  weight: '0',
  progress: '0',
  planned_start: '',
  planned_end: '',
  status: 'pending',
  notes: '',
  segment_from: '',
  segment_to: '',
  saha_stage: '',
};

const EMPTY_TASK = {
  work_group_id: '',
  title: '',
  description: '',
  assignee_id: '',
  due_date: '',
  status: 'todo',
  priority: 'normal',
};

const DEFAULT_AUTO_OPTS = {
  mode: 'hybrid',
  start_date: '',
  end_date: '',
  segment_size: 20,
  weight_source: 'template',
  include_phase_tasks: true,
  include_crossing_tasks: true,
  include_parcel_tasks: true,
  replace_existing: true,
};

function ProgressBar({ value, mini }) {
  const v = Math.min(100, Math.max(0, Number(value) || 0));
  return (
    <div className={`progress-track${mini ? ' mini' : ''}`}>
      <div className="progress-fill" style={{ width: `${v}%` }} />
      <span className="progress-label">{v}%</span>
    </div>
  );
}

export default function WorkTracking() {
  const { projects, projectId, setProjectId, reloadProjects: loadProjects } = useProjects();
  const [groups, setGroups] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [selGroup, setSelGroup] = useState(null);
  const [groupModal, setGroupModal] = useState(null);
  const [taskModal, setTaskModal] = useState(null);
  const [autoModal, setAutoModal] = useState(false);
  const [autoOpts, setAutoOpts] = useState(DEFAULT_AUTO_OPTS);
  const [autoPreview, setAutoPreview] = useState(null);
  const [autoLoading, setAutoLoading] = useState(false);
  const [syncingSaha, setSyncingSaha] = useState(false);
  const [tab, setTab] = useState('plan');
  const [projModal, setProjModal] = useState(null);
  const [projName, setProjName] = useState('');
  const [projType, setProjType] = useState('enh');
  const [projCapacity, setProjCapacity] = useState('');
  const [projEmployer, setProjEmployer] = useState('');
  const [projContractNo, setProjContractNo] = useState('');
  const [projStartDate, setProjStartDate] = useState('');
  const [projEndDate, setProjEndDate] = useState('');
  const [gForm, setGForm] = useState(EMPTY_GROUP);
  const [tForm, setTForm] = useState(EMPTY_TASK);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    if (projectId == null) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const [g, t, u] = await Promise.all([
        api.get(`/api/workgroups?project_id=${projectId}`),
        api.get(`/api/tasks?project_id=${projectId}`),
        api.get('/api/users'),
      ]);
      setGroups(g);
      setTasks(t);
      setUsers(u);
      setSelGroup((prev) => (prev && g.some((x) => x.id === prev.id) ? prev : null));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Otomatik iş planı sihirbazı açıkken seçenekler değiştikçe önizlemeyi yenile
  useEffect(() => {
    if (!autoModal || projectId == null) return;
    let cancelled = false;
    setAutoLoading(true);
    const qs = new URLSearchParams({
      project_id: String(projectId),
      mode: autoOpts.mode,
      segment_size: String(autoOpts.segment_size || 20),
      weight_source: autoOpts.weight_source,
      include_phase_tasks: String(autoOpts.include_phase_tasks),
      include_crossing_tasks: String(autoOpts.include_crossing_tasks),
      include_parcel_tasks: String(autoOpts.include_parcel_tasks),
    });
    if (autoOpts.start_date) qs.set('start_date', autoOpts.start_date);
    if (autoOpts.end_date) qs.set('end_date', autoOpts.end_date);

    api
      .get(`/api/workgroups/auto-preview?${qs.toString()}`)
      .then((d) => {
        if (cancelled) return;
        setAutoPreview(d);
        setAutoOpts((prev) => ({
          ...prev,
          start_date: prev.start_date || d.resolved_dates?.start_date || '',
          end_date: prev.end_date || d.resolved_dates?.end_date || '',
        }));
      })
      .catch((e) => {
        if (!cancelled) setFormError(e.message);
      })
      .finally(() => {
        if (!cancelled) setAutoLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    autoModal,
    projectId,
    autoOpts.mode,
    autoOpts.start_date,
    autoOpts.end_date,
    autoOpts.segment_size,
    autoOpts.weight_source,
    autoOpts.include_phase_tasks,
    autoOpts.include_crossing_tasks,
    autoOpts.include_parcel_tasks,
  ]);

  function openAutoWizard() {
    const p = projects.find((x) => x.id === projectId);
    setFormError(null);
    setAutoPreview(null);
    setAutoOpts({
      ...DEFAULT_AUTO_OPTS,
      start_date: p?.start_date || '',
      end_date: p?.end_date || '',
      replace_existing: true,
    });
    setAutoModal(true);
  }

  async function submitAutoGenerate(e) {
    e.preventDefault();
    if (projectId == null) return;
    if (autoOpts.replace_existing && groups.length > 0) {
      const ok = window.confirm(
        `Mevcut ${groups.length} iş grubu ve bağlı görevleri silinip yeni otomatik iş planı oluşturulacak. Onaylıyor musunuz?`
      );
      if (!ok) return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await api.post('/api/workgroups/auto-generate', {
        project_id: projectId,
        ...autoOpts,
      });
      setAutoModal(false);
      await loadProjects();
      await load();
      setNotice(
        `Otomatik iş planı oluşturuldu: ${res.created_groups} iş grubu ve ${res.created_tasks} görev eklendi` +
          (res.synced_groups > 0 ? ` · ${res.synced_groups} grup saha ilerlemesiyle eşitlendi.` : '.')
      );
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSyncSaha() {
    if (projectId == null) return;
    setSyncingSaha(true);
    setNotice(null);
    try {
      const res = await api.post('/api/workgroups/sync-saha', { project_id: projectId });
      await load();
      setNotice(
        res.updated > 0
          ? `${res.updated} iş grubunun ilerlemesi saha direk durumlarından güncellendi.`
          : 'Tüm iş grupları güncel saha ilerlemesiyle zaten uyumlu.'
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncingSaha(false);
    }
  }

  function resetProjForm() {
    setProjName('');
    setProjType('enh');
    setProjCapacity('');
    setProjEmployer('');
    setProjContractNo('');
    setProjStartDate('');
    setProjEndDate('');
    setFormError(null);
  }

  async function submitProject(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const payload = {
      name: projName,
      type: projType,
      capacity: projCapacity,
      employer: projEmployer,
      contract_no: projContractNo,
      start_date: projStartDate,
      end_date: projEndDate,
    };

    try {
      if (projModal.mode === 'new') {
        const created = await api.post('/api/projects', payload);
        await api
          .post('/api/workgroups/auto-generate', {
            project_id: created.id,
            mode: 'hybrid',
            start_date: projStartDate || null,
            end_date: projEndDate || null,
            replace_existing: true,
          })
          .catch(() => {});
        await loadProjects();
        setProjectId(created.id);
      } else {
        await api.put(`/api/projects/${projModal.proj.id}`, payload);
        await loadProjects();
      }
      setProjModal(null);
      resetProjForm();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function removeProject() {
    const proj = projects.find((p) => p.id === projectId);
    const ok = window.confirm(
      `"${proj?.name}" projesi SİLİNECEK — direkleri, iş grupları ve görevleri dahil. Emin misiniz?`
    );
    if (!ok) return;
    try {
      await api.del(`/api/projects/${projectId}`);
      await loadProjects();
    } catch (e) {
      alert('Silme başarısız: ' + e.message);
    }
  }

  const groupTasks = useMemo(
    () => (selGroup ? tasks.filter((t) => t.work_group_id === selGroup.id) : []),
    [tasks, selGroup]
  );

  // Ağırlıklı genel ilerleme
  const overall = useMemo(() => {
    const wSum = groups.reduce((s, g) => s + Number(g.weight || 0), 0);
    if (wSum > 0) {
      const num = groups.reduce((s, g) => s + Number(g.progress || 0) * Number(g.weight || 0), 0);
      return Math.round((num / wSum) * 10) / 10;
    }
    return groups.length
      ? Math.round((groups.reduce((s, g) => s + Number(g.progress || 0), 0) / groups.length) * 10) / 10
      : 0;
  }, [groups]);

  const lateTasks = useMemo(
    () => tasks.filter((t) => t.status !== 'done' && t.due_date && t.due_date < today()),
    [tasks]
  );
  const openTasks = useMemo(() => tasks.filter((t) => t.status !== 'done'), [tasks]);

  // ---------- grup form ----------
  function openNewGroup() {
    setGForm(EMPTY_GROUP);
    setFormError(null);
    setGroupModal({ mode: 'new' });
  }
  function openEditGroup(g) {
    setGForm({
      code: g.code,
      name: g.name,
      weight: String(g.weight ?? 0),
      progress: String(g.progress ?? 0),
      planned_start: g.planned_start || '',
      planned_end: g.planned_end || '',
      status: g.status,
      notes: g.notes || '',
      segment_from: g.segment_from == null ? '' : String(g.segment_from),
      segment_to: g.segment_to == null ? '' : String(g.segment_to),
      saha_stage: g.saha_stage || '',
    });
    setFormError(null);
    setGroupModal({ mode: 'edit', group: g });
  }
  function gSet(field) {
    return (e) => setGForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function submitGroup(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const sf = gForm.segment_from === '' ? null : Number(gForm.segment_from);
    const st = gForm.segment_to === '' ? null : Number(gForm.segment_to);
    if ((sf == null) !== (st == null)) {
      setFormError('Direk kesimi için başlangıç VE bitiş direğini birlikte girin.');
      setSaving(false);
      return;
    }
    if (sf != null && (!Number.isInteger(sf) || !Number.isInteger(st) || sf < 1 || st < 1 || sf > st)) {
      setFormError('Geçersiz direk aralığı (1 ≤ başlangıç ≤ bitiş).');
      setSaving(false);
      return;
    }
    const payload = {
      ...gForm,
      weight: Number(gForm.weight),
      progress: Number(gForm.progress),
      segment_from: sf,
      segment_to: st,
      project_id: projectId,
    };
    try {
      if (groupModal.mode === 'new') {
        const created = await api.post('/api/workgroups', payload);
        setGroups((prev) => [...prev, created]);
      } else {
        const updated = await api.put(`/api/workgroups/${groupModal.group.id}`, payload);
        setGroups((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
      }
      setGroupModal(null);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function removeGroup(g) {
    const ok = window.confirm(`"${g.name}" iş grubu ve tüm görevleri silinecek. Emin misiniz?`);
    if (!ok) return;
    try {
      await api.del(`/api/workgroups/${g.id}`);
      await load();
    } catch (e) {
      alert('Silme başarısız: ' + e.message);
    }
  }

  // ---------- görev form ----------
  function openNewTask() {
    setTForm({ ...EMPTY_TASK, work_group_id: selGroup ? String(selGroup.id) : '' });
    setFormError(null);
    setTaskModal({ mode: 'new' });
  }
  function openEditTask(t) {
    setTForm({
      work_group_id: String(t.work_group_id),
      title: t.title,
      description: t.description || '',
      assignee_id: t.assignee_id == null ? '' : String(t.assignee_id),
      due_date: t.due_date || '',
      status: t.status,
      priority: t.priority,
    });
    setFormError(null);
    setTaskModal({ mode: 'edit', task: t });
  }
  function tSet(field) {
    return (e) => setTForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function submitTask(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const payload = {
      ...tForm,
      work_group_id: Number(tForm.work_group_id),
      assignee_id: tForm.assignee_id === '' ? null : Number(tForm.assignee_id),
    };
    try {
      if (taskModal.mode === 'new') {
        const created = await api.post('/api/tasks', payload);
        setTasks((prev) => [...prev, created]);
      } else {
        const updated = await api.put(`/api/tasks/${taskModal.task.id}`, payload);
        setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      }
      setTaskModal(null);
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function removeTask(t) {
    const ok = window.confirm(`"${t.title}" görevi silinecek. Emin misiniz?`);
    if (!ok) return;
    try {
      await api.del(`/api/tasks/${t.id}`);
      await load();
    } catch (e) {
      alert('Silme başarısız: ' + e.message);
    }
  }

  // Durum döngüsü: yapılacak -> devam -> tamamlandı -> yapılacak
  async function cycleStatus(t) {
    const order = ['todo', 'in_progress', 'done'];
    const next = order[(order.indexOf(t.status) + 1) % order.length];
    try {
      await api.put(`/api/tasks/${t.id}`, {
        work_group_id: t.work_group_id,
        title: t.title,
        description: t.description,
        assignee_id: t.assignee_id,
        due_date: t.due_date,
        priority: t.priority,
        status: next,
      });
      await load();
    } catch (e) {
      alert('Durum değiştirilemedi: ' + e.message);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>İş Takibi &amp; Güzergah</h1>
          <p className="sub">İş grupları, görevler ve ilerleme</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => apiDownload(`/api/export/worktracking?project_id=${projectId || ''}`, 'ptyp-is-takibi.xlsx')}>
            Excel
          </button>
          {tab === 'plan' && projectId != null && (
            <>
              <button className="btn" onClick={handleSyncSaha} disabled={syncingSaha} title="Saha direk durumlarından iş grubu ilerlemelerini güncelle">
                {syncingSaha ? 'Eşitleniyor…' : '🔄 Sahadan Güncelle'}
              </button>
              <button className="btn" onClick={openAutoWizard} title="Proje tipi, DTL, gergi kantonları ve geçişlerden otomatik iş planı oluştur">
                ⚡ Otomatik İş Planı
              </button>
              <button className="btn btn-accent" onClick={openNewGroup}>
                + Yeni İş Grubu
              </button>
            </>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>PROJE:</span>
        <select value={projectId ?? ''} onChange={(e) => setProjectId(Number(e.target.value))}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {p.pole_count} direk · {p.group_count} grup
            </option>
          ))}
        </select>
        <button className="btn btn-sm" onClick={() => { resetProjForm(); setProjModal({ mode: 'new' }); }}>
          + Yeni Proje
        </button>
        {projectId != null && (
          <button
            className="btn btn-sm"
            title="Proje adını değiştir"
            onClick={() => {
              const p = projects.find((x) => x.id === projectId);
              setProjName(p?.name || '');
              setProjType(p?.type || 'enh');
              setProjCapacity(p?.capacity || '');
              setProjEmployer(p?.employer || '');
              setProjContractNo(p?.contract_no || '');
              setProjStartDate(p?.start_date || '');
              setProjEndDate(p?.end_date || '');
              setFormError(null);
              setProjModal({ mode: 'rename', proj: p });
            }}
          >
            Ad Değiştir
          </button>
        )}
        {projects.length > 1 && (
          <button className="btn btn-sm btn-danger" onClick={removeProject} title="Projeyi sil">Sil</button>
        )}
      </div>

      <div className="tabs">
        <button className={tab === 'plan' ? 'active' : ''} onClick={() => setTab('plan')}>
          İş Planı
        </button>
        <button className={tab === 'guzergah' ? 'active' : ''} onClick={() => setTab('guzergah')}>
          Güzergah &amp; Harita
        </button>
      </div>

      {tab === 'guzergah' ? (
        projectId != null ? <RouteMap embedded projectId={projectId} key={projectId} /> : null
      ) : (
        <>
          {error && (
            <div className="error-banner">
              <span>Veriler yüklenemedi: {error}</span>
              <button className="btn btn-sm" onClick={load}>Tekrar Dene</button>
            </div>
          )}

          {notice && (
            <div className="notice-banner" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <span>{notice}</span>
              <button className="btn btn-sm" onClick={() => setNotice(null)}>Kapat</button>
            </div>
          )}

          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
              <h3 style={{ marginBottom: 8 }}>Ağırlıklı Genel İlerleme</h3>
              <strong style={{ fontSize: 18 }}>%{overall}</strong>
            </div>
            <ProgressBar value={overall} />
            <div className="quote-stats" style={{ marginTop: 12, marginBottom: 0 }}>
              <div>İş Grubu <strong>{groups.length}</strong></div>
              <div>Açık Görev <strong>{openTasks.length}</strong></div>
              <div>Geciken Görev <strong className={lateTasks.length > 0 ? 'diff-neg' : 'diff-pos'}>{lateTasks.length}</strong></div>
              <div>Tamamlanan <strong>{tasks.length - openTasks.length}</strong></div>
            </div>
          </div>

          {loading ? (
            <div className="empty"><span className="empty-ico"></span>Yükleniyor…</div>
          ) : groups.length === 0 ? (
            <div className="empty">
              <span className="empty-ico"></span>
              <div>Henüz iş grubu yok.</div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-accent" onClick={openAutoWizard}>
                  ⚡ Otomatik İş Planı Oluştur
                </button>
                <button className="btn" onClick={openNewGroup}>
                  + Elle İş Grubu Ekle
                </button>
              </div>
            </div>
          ) : (
            <div className="table-wrap" style={{ marginBottom: 16 }}>
              <table>
                <thead>
                  <tr>
                    <th>Kod</th>
                    <th>İş Grubu</th>
                    <th>Direk Kesimi</th>
                    <th className="num">Ağırlık</th>
                    <th>İlerleme</th>
                    <th className="num">Saha %</th>
                    <th className="num">Görev</th>
                    <th>Tarih Aralığı</th>
                    <th>Durum</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <tr
                      key={g.id}
                      onClick={() => setSelGroup(selGroup?.id === g.id ? null : g)}
                      style={{ cursor: 'pointer' }}
                      className={selGroup?.id === g.id ? 'best' : ''}
                    >
                      <td className="muted">{g.code}</td>
                      <td style={{ fontWeight: 600 }}>{g.name}</td>
                      <td>
                        {g.segment_from != null ? (
                          <span className="badge badge-blue">D{g.segment_from} → D{g.segment_to}</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">{g.weight}%</td>
                      <td style={{ minWidth: 130 }}><ProgressBar value={g.progress} mini /></td>
                      <td className="num">
                        {g.saha_progress != null ? (
                          <div>
                            <Link
                              to="/saha"
                              title="Saha direk durumlarından hesaplanır"
                              style={{ color: 'inherit', fontWeight: 600 }}
                            >
                              %{g.saha_progress}
                            </Link>
                            {g.saha_stage && g.saha_stage !== 'all' && (
                              <div className="muted" style={{ fontSize: 10.5 }}>
                                {SAHA_STAGE_LABELS[g.saha_stage] || g.saha_stage}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">
                        {g.done_count}/{g.task_count}
                        {g.late_count > 0 && <span className="diff-neg" title="Geciken görev"> ({g.late_count})</span>}
                      </td>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {g.planned_start ? fmtDate(g.planned_start) : '—'} → {g.planned_end ? fmtDate(g.planned_end) : '—'}
                      </td>
                      <td><StatusBadge meta={GROUP_STATUS[g.status]} /></td>
                      <td style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                        <button className="btn btn-sm" title="Düzenle" onClick={() => openEditGroup(g)}>Düzenle</button>
                        <button className="btn btn-sm btn-danger" title="Sil" onClick={() => removeGroup(g)}>Sil</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selGroup && (
            <div className="card">
              <div className="quote-panel-head">
                <div>
                  <h3 style={{ marginBottom: 4 }}>
                    {selGroup.name} <span className="muted" style={{ fontWeight: 400 }}>({selGroup.code}) — Görevler</span>
                  </h3>
                  {selGroup.notes && <div className="muted" style={{ fontSize: 12.5 }}>{selGroup.notes}</div>}
                </div>
                <button className="btn btn-accent" onClick={openNewTask}>+ Görev Ekle</button>
              </div>

              {groupTasks.length === 0 ? (
                <div className="empty">
                  <span className="empty-ico"></span>
                  Bu grupta henüz görev yok.
                </div>
              ) : (
                <div className="table-wrap" style={{ border: 'none' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Görev</th>
                        <th>Atanan</th>
                        <th>Termin</th>
                        <th>Öncelik</th>
                        <th>Durum (tıkla değiştir)</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupTasks.map((t) => {
                        const isLate = t.status !== 'done' && t.due_date && t.due_date < today();
                        return (
                          <tr key={t.id} className={isLate ? 'late-row' : ''}>
                            <td>
                              <div style={{ fontWeight: 600 }}>
                                {t.title}
                              </div>
                              {t.description && <div className="muted" style={{ fontSize: 11.5, maxWidth: 420 }}>{t.description}</div>}
                            </td>
                            <td>{t.assignee_name || <span className="muted">—</span>}</td>
                            <td className={isLate ? 'diff-neg' : 'muted'} style={{ whiteSpace: 'nowrap' }}>
                              {t.due_date ? fmtDate(t.due_date) : '—'}
                            </td>
                            <td><StatusBadge meta={PRIORITY[t.priority]} /></td>
                            <td>
                              <button
                                className={`badge ${TASK_STATUS[t.status].cls}`}
                                style={{ border: 'none', cursor: 'pointer' }}
                                onClick={() => cycleStatus(t)}
                                title="Durumu değiştirmek için tıklayın"
                              >
                                {TASK_STATUS[t.status].label}
                              </button>
                            </td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              <button className="btn btn-sm" title="Düzenle" onClick={() => openEditTask(t)}>Düzenle</button>
                              <button className="btn btn-sm btn-danger" title="Sil" onClick={() => removeTask(t)}>Sil</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {autoModal && (
        <Modal
          title="⚡ Otomatik İş Planı Oluşturucu"
          onClose={() => setAutoModal(false)}
          wide
        >
          <form onSubmit={submitAutoGenerate}>
            {formError && <div className="form-error">{formError}</div>}

            {autoPreview?.stats && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <span className="badge badge-blue">
                  Proje Tipi: {String(autoPreview.stats.project_type || 'enh').toUpperCase()}
                </span>
                <span className="badge">
                  Direk: {autoPreview.stats.pole_count > 0 ? `${autoPreview.stats.pole_count} adet (D-${autoPreview.stats.min_pole} → D-${autoPreview.stats.max_pole})` : 'Yok'}
                </span>
                <span className="badge">
                  DTL Gergi Kantonu: {autoPreview.stats.canton_count}
                </span>
                <span className="badge">
                  Özel Geçiş: {autoPreview.stats.crossing_count}
                </span>
                {autoPreview.stats.unpermitted_parcel_count > 0 && (
                  <span className="badge badge-amber">
                    İzinsiz/Başvuruda Parsel: {autoPreview.stats.unpermitted_parcel_count}
                  </span>
                )}
              </div>
            )}

            <div className="form-row">
              <div className="field">
                <label>İş Planı Yapısı</label>
                <select
                  value={autoOpts.mode}
                  onChange={(e) => setAutoOpts((o) => ({ ...o, mode: e.target.value }))}
                >
                  <option value="hybrid">İmalat Fazları + Kanton/Geçiş Görevleri (Önerilen — Hibrit)</option>
                  <option value="canton">DTL Gergi (KD/KT/N) Kantonlarına Göre İş Grupları</option>
                  <option value="segment">Eşit Direk Kesimlerine Göre İş Grupları (Ekip Bölgesi)</option>
                  <option value="phase">Yalnızca Standart İmalat Fazları</option>
                </select>
              </div>
              <div className="field">
                <label>Ağırlık (%) Hesabı</label>
                <select
                  value={autoOpts.weight_source}
                  onChange={(e) => setAutoOpts((o) => ({ ...o, weight_source: e.target.value }))}
                >
                  <option value="template">Standart Mühendislik Ağırlıkları (%100)</option>
                  <option value="kesif">
                    Keşif (BOQ) Maliyet Dağılımından{autoPreview?.stats?.kesif_priced_count ? ` (${autoPreview.stats.kesif_priced_count} fiyatlı kalem)` : ' (fiyat girilmişse)'}
                  </option>
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="field">
                <label>Plan Başlangıç Tarihi</label>
                <input
                  type="date"
                  value={autoOpts.start_date}
                  onChange={(e) => setAutoOpts((o) => ({ ...o, start_date: e.target.value }))}
                  required
                />
              </div>
              <div className="field">
                <label>Plan Bitiş Tarihi</label>
                <input
                  type="date"
                  value={autoOpts.end_date}
                  onChange={(e) => setAutoOpts((o) => ({ ...o, end_date: e.target.value }))}
                  required
                />
              </div>
              {(autoOpts.mode === 'segment' || (autoOpts.mode === 'hybrid' && (autoPreview?.stats?.canton_count || 0) < 2)) && (
                <div className="field">
                  <label>Kesim Boyutu (Direk Adedi)</label>
                  <input
                    type="number"
                    min="5"
                    max="100"
                    value={autoOpts.segment_size}
                    onChange={(e) => setAutoOpts((o) => ({ ...o, segment_size: Number(e.target.value) || 20 }))}
                  />
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '8px 0 12px', fontSize: 13 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={autoOpts.include_phase_tasks}
                  onChange={(e) => setAutoOpts((o) => ({ ...o, include_phase_tasks: e.target.checked }))}
                />
                <span>İmalat fazı ve kanton/kesim alt görevlerini otomatik oluştur</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={autoOpts.include_crossing_tasks}
                  onChange={(e) => setAutoOpts((o) => ({ ...o, include_crossing_tasks: e.target.checked }))}
                />
                <span>
                  DTL özel geçişleri (E.İ.H., Karayolu, Demiryolu vb.) için izin &amp; güvenlik görevi aç
                  {autoPreview?.stats?.crossing_count ? ` (${autoPreview.stats.crossing_count} geçiş bulundu)` : ''}
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={autoOpts.include_parcel_tasks}
                  onChange={(e) => setAutoOpts((o) => ({ ...o, include_parcel_tasks: e.target.checked }))}
                />
                <span>
                  Kamulaştırma / izinsiz parsel açıklıkları için takip görevi aç
                  {autoPreview?.stats?.unpermitted_parcel_count ? ` (${autoPreview.stats.unpermitted_parcel_count} parsel)` : ''}
                </span>
              </label>
              {groups.length > 0 && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={autoOpts.replace_existing}
                    onChange={(e) => setAutoOpts((o) => ({ ...o, replace_existing: e.target.checked }))}
                  />
                  <span>Mevcut {groups.length} iş grubunu sıfırlayıp temiz iş planı kur (önerilir)</span>
                </label>
              )}
            </div>

            {autoLoading ? (
              <div className="muted" style={{ padding: '12px 0', textAlign: 'center' }}>Önizleme hesaplanıyor…</div>
            ) : autoPreview?.groups?.length > 0 ? (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <strong style={{ fontSize: 12.5 }}>
                    Oluşturulacak İş Grupları ({autoPreview.groups.length} grup · {autoPreview.tasks.length} otomatik görev)
                  </strong>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Toplam Süre: {autoPreview.resolved_dates.span_days} gün
                  </span>
                </div>
                <div className="table-wrap" style={{ maxHeight: 240, overflow: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Kod</th>
                        <th>İş Grubu</th>
                        <th>Kesim</th>
                        <th className="num">Ağırlık</th>
                        <th>Saha Aşaması</th>
                        <th>Planlanan Tarih</th>
                      </tr>
                    </thead>
                    <tbody>
                      {autoPreview.groups.map((g) => (
                        <tr key={g.code}>
                          <td className="muted">{g.code}</td>
                          <td style={{ fontWeight: 600 }}>{g.name}</td>
                          <td>
                            {g.segment_from != null ? `D${g.segment_from}→D${g.segment_to}` : '—'}
                          </td>
                          <td className="num">%{g.weight}</td>
                          <td className="muted" style={{ fontSize: 11.5 }}>
                            {g.saha_stage ? SAHA_STAGE_LABELS[g.saha_stage] || g.saha_stage : '—'}
                          </td>
                          <td className="muted" style={{ whiteSpace: 'nowrap', fontSize: 11.5 }}>
                            {fmtDate(g.planned_start)} → {fmtDate(g.planned_end)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setAutoModal(false)}>Vazgeç</button>
              <button type="submit" className="btn btn-accent" disabled={saving || autoLoading}>
                {saving ? 'Oluşturuluyor…' : '⚡ İş Planını Oluştur'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {projModal && (
        <Modal
          title={projModal.mode === 'new' ? 'Yeni Proje (Şantiye)' : 'Proje Adını Değiştir'}
          onClose={() => setProjModal(null)}
        >
          <form onSubmit={submitProject}>
            {formError && <div className="form-error">{formError}</div>}
            <div className="form-row">
              <div className="field">
                <label>Proje Adı *</label>
                <input
                  value={projName}
                  onChange={(e) => setProjName(e.target.value)}
                  required
                  autoFocus
                  placeholder="Örn: Şantiye 2"
                />
              </div>
              <div className="field">
                <label>Proje Tipi</label>
                <select value={projType} onChange={(e) => setProjType(e.target.value)}>
                  <option value="enh">ENH (Enerji Nakil Hattı)</option>
                  <option value="tm">TM (Trafo Merkezi)</option>
                  <option value="ges">GES (Güneş Enerji Santrali)</option>
                  <option value="res">RES (Rüzgar Enerji Santrali)</option>
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="field">
                <label>İşveren</label>
                <input value={projEmployer} onChange={(e) => setProjEmployer(e.target.value)} placeholder="Örn: TEİAŞ" />
              </div>
              <div className="field">
                <label>Kapasite</label>
                <input value={projCapacity} onChange={(e) => setProjCapacity(e.target.value)} placeholder="Örn: 154 kV / 50 MW" />
              </div>
            </div>

            <div className="form-row">
              <div className="field">
                <label>Sözleşme No</label>
                <input value={projContractNo} onChange={(e) => setProjContractNo(e.target.value)} />
              </div>
            </div>

            <div className="form-row">
              <div className="field">
                <label>Başlangıç Tarihi</label>
                <input type="date" value={projStartDate} onChange={(e) => setProjStartDate(e.target.value)} />
              </div>
              <div className="field">
                <label>Bitiş Tarihi</label>
                <input type="date" value={projEndDate} onChange={(e) => setProjEndDate(e.target.value)} />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setProjModal(null)}>Vazgeç</button>
              <button type="submit" className="btn btn-accent" disabled={saving}>
                {saving ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {groupModal && (
        <Modal
          title={groupModal.mode === 'new' ? 'Yeni İş Grubu' : `İş Grubu Düzenle — ${groupModal.group.code}`}
          onClose={() => setGroupModal(null)}
        >
          <form onSubmit={submitGroup}>
            {formError && <div className="form-error">{formError}</div>}
            <div className="form-row">
              <div className="field">
                <label>Kod</label>
                <input value={gForm.code} onChange={gSet('code')} placeholder="Boş otomatik (WG-01)" />
              </div>
              <div className="field">
                <label>İş Grubu Adı *</label>
                <input value={gForm.name} onChange={gSet('name')} required autoFocus placeholder="Örn: ENH Direk Dikim" />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Ağırlık (%)</label>
                <input type="number" min="0" max="100" step="any" value={gForm.weight} onChange={gSet('weight')} />
                <div className="form-hint">Proje içindeki payı — toplam %100 olmalı</div>
              </div>
              <div className="field">
                <label>Fiziki İlerleme (%)</label>
                <input type="number" min="0" max="100" step="any" value={gForm.progress} onChange={gSet('progress')} />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Başlangıç Direği</label>
                <input type="number" min="1" step="1" value={gForm.segment_from} onChange={gSet('segment_from')} placeholder="Boş = kesim yok" />
              </div>
              <div className="field">
                <label>Bitiş Direği</label>
                <input type="number" min="1" step="1" value={gForm.segment_to} onChange={gSet('segment_to')} placeholder="Boş = kesim yok" />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Saha Aşaması Bağlantısı</label>
                <select value={gForm.saha_stage || ''} onChange={gSet('saha_stage')}>
                  <option value="">Genel Direk Ortalaması</option>
                  <option value="excavation">Kazı Aşaması (≥Kazı olan direkler)</option>
                  <option value="foundation">Temel Aşaması (≥Temel olan direkler)</option>
                  <option value="erection">Direk Montajı (≥Montaj olan direkler)</option>
                  <option value="fittings">Donanım / İzolatör (≥Donanım olan direkler)</option>
                  <option value="stringing">İletken Çekimi (≥Tel Çekimi olan direkler)</option>
                  <option value="completed">Tamamlanma (Tamamlanan direkler)</option>
                </select>
                <div className="form-hint">Saha sayfasında direk durumu güncellendikçe bu grubun ilerlemesi otomatik güncellenir</div>
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Planlanan Başlangıç</label>
                <input type="date" value={gForm.planned_start} onChange={gSet('planned_start')} />
              </div>
              <div className="field">
                <label>Planlanan Bitiş</label>
                <input type="date" value={gForm.planned_end} onChange={gSet('planned_end')} />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Durum</label>
                <select value={gForm.status} onChange={gSet('status')}>
                  {Object.entries(GROUP_STATUS).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Not</label>
                <input value={gForm.notes} onChange={gSet('notes')} />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setGroupModal(null)}>Vazgeç</button>
              <button type="submit" className="btn btn-accent" disabled={saving}>
                {saving ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {taskModal && (
        <Modal
          title={taskModal.mode === 'new' ? 'Yeni Görev' : 'Görev Düzenle'}
          onClose={() => setTaskModal(null)}
        >
          <form onSubmit={submitTask}>
            {formError && <div className="form-error">{formError}</div>}
            <div className="field">
              <label>İş Grubu *</label>
              <select value={tForm.work_group_id} onChange={tSet('work_group_id')} required>
                <option value="">Seçin…</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.code} — {g.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Görev Başlığı *</label>
              <input value={tForm.title} onChange={tSet('title')} required autoFocus placeholder="Örn: Direk temel kazısı — km 12-18" />
            </div>
            <div className="field">
              <label>Açıklama</label>
              <textarea value={tForm.description} onChange={tSet('description')} placeholder="Detay, kapsam, notlar…" />
            </div>
            <div className="form-row">
              <div className="field">
                <label>Atanan Kişi</label>
                <select value={tForm.assignee_id} onChange={tSet('assignee_id')}>
                  <option value="">— Atanmadı —</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.display_name || u.username}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Termin</label>
                <input type="date" value={tForm.due_date} onChange={tSet('due_date')} />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Öncelik</label>
                <select value={tForm.priority} onChange={tSet('priority')}>
                  {Object.entries(PRIORITY).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Durum</label>
                <select value={tForm.status} onChange={tSet('status')}>
                  {Object.entries(TASK_STATUS).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setTaskModal(null)}>Vazgeç</button>
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
