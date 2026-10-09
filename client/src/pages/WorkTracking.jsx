import { useEffect, useMemo, useState } from 'react';
import { api, apiDownload } from '../api';
import { fmtDate, StatusBadge } from '../utils';
import Modal from '../components/Modal';

const GROUP_STATUS = {
  pending: { label: 'Başlamadı', cls: 'badge-gray' },
  active: { label: 'Devam Ediyor', cls: 'badge-blue' },
  completed: { label: 'Tamamlandı', cls: 'badge-green' },
};

const TASK_STATUS = {
  todo: { label: 'Yapılacak', cls: 'badge-gray' },
  in_progress: { label: 'Devam Ediyor', cls: 'badge-blue' },
  done: { label: 'Tamamlandı ✓', cls: 'badge-green' },
};

const PRIORITY = {
  low: { label: 'Düşük', cls: 'badge-gray' },
  normal: { label: 'Normal', cls: 'badge-blue' },
  high: { label: 'Yüksek', cls: 'badge-amber' },
};

const EMPTY_GROUP = {
  code: '', name: '', weight: '0', progress: '0',
  planned_start: '', planned_end: '', status: 'pending', notes: '',
};

const EMPTY_TASK = {
  work_group_id: '', title: '', description: '',
  assignee_id: '', due_date: '', status: 'todo', priority: 'normal',
};

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
  const [groups, setGroups] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selGroup, setSelGroup] = useState(null);
  const [groupModal, setGroupModal] = useState(null);
  const [taskModal, setTaskModal] = useState(null);
  const [gForm, setGForm] = useState(EMPTY_GROUP);
  const [tForm, setTForm] = useState(EMPTY_TASK);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setError(null);
      const [g, t, u] = await Promise.all([
        api.get('/api/workgroups'),
        api.get('/api/tasks'),
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
  }, []);

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
      code: g.code, name: g.name, weight: String(g.weight ?? 0), progress: String(g.progress ?? 0),
      planned_start: g.planned_start || '', planned_end: g.planned_end || '',
      status: g.status, notes: g.notes || '',
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
    const payload = { ...gForm, weight: Number(gForm.weight), progress: Number(gForm.progress) };
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
      work_group_id: String(t.work_group_id), title: t.title, description: t.description || '',
      assignee_id: t.assignee_id == null ? '' : String(t.assignee_id),
      due_date: t.due_date || '', status: t.status, priority: t.priority,
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

  // Durum döngüsü: yapılacak → devam → tamamlandı → yapılacak
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
          <h1>🔧 İş Takibi</h1>
          <p className="sub">İş grupları, görevler ve ağırlıklı fiziki ilerleme</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={() => apiDownload('/api/export/worktracking', 'ptyp-is-takibi.xlsx')}>⬇️ Excel</button>
          <button className="btn btn-accent" onClick={openNewGroup}>＋ Yeni İş Grubu</button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <span>Veriler yüklenemedi: {error}</span>
          <button className="btn btn-sm" onClick={load}>Tekrar Dene</button>
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
        <div className="empty"><span className="empty-ico">⏳</span>Yükleniyor…</div>
      ) : groups.length === 0 ? (
        <div className="empty">
          <span className="empty-ico">🔧</span>
          Henüz iş grubu yok. İlk iş grubunu ekleyin (örn. "ENH Direk Dikim", "Trafo Merkezi Bina").
        </div>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table>
            <thead>
              <tr>
                <th>Kod</th>
                <th>İş Grubu</th>
                <th className="num">Ağırlık</th>
                <th>İlerleme</th>
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
                  <td className="num">{g.weight}%</td>
                  <td style={{ minWidth: 130 }}><ProgressBar value={g.progress} mini /></td>
                  <td className="num">
                    {g.done_count}/{g.task_count}
                    {g.late_count > 0 && <span className="diff-neg" title="Geciken görev"> ⚠️{g.late_count}</span>}
                  </td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                    {g.planned_start ? fmtDate(g.planned_start) : '—'} → {g.planned_end ? fmtDate(g.planned_end) : '—'}
                  </td>
                  <td><StatusBadge meta={GROUP_STATUS[g.status]} /></td>
                  <td style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title="Düzenle" onClick={() => openEditGroup(g)}>✏️</button>
                    <button className="icon-btn" title="Sil" onClick={() => removeGroup(g)}>🗑️</button>
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
            <button className="btn btn-accent" onClick={openNewTask}>＋ Görev Ekle</button>
          </div>

          {groupTasks.length === 0 ? (
            <div className="empty">
              <span className="empty-ico">📝</span>
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
                    <th>Durum (tıkla → değiştir)</th>
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
                            {isLate && '⚠️ '}
                            {t.title}
                          </div>
                          {t.description && <div className="muted" style={{ fontSize: 11.5, maxWidth: 320 }}>{t.description}</div>}
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
                          <button className="icon-btn" title="Düzenle" onClick={() => openEditTask(t)}>✏️</button>
                          <button className="icon-btn" title="Sil" onClick={() => removeTask(t)}>🗑️</button>
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
                <input value={gForm.code} onChange={gSet('code')} placeholder="Boş → otomatik (WG-01)" />
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
