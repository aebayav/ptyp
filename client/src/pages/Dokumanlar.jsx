import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { fmtDate } from '../utils';

const CATEGORIES = {
  pafta: 'Pafta / Çizim',
  dtl: 'DTL / Profil',
  onay: 'Onay Yazısı',
  diger: 'Diğer',
};

const CATEGORY_BADGE = {
  pafta: 'badge-blue',
  dtl: 'badge-green',
  onay: 'badge-amber',
  diger: 'badge-gray',
};

export default function Dokumanlar() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [form, setForm] = useState({ title: '', category: 'pafta', revision: 'R0', notes: '' });
  const fileRef = useRef(null);

  useEffect(() => {
    api
      .get('/api/projects')
      .then((p) => {
        setProjects(p);
        setProjectId(p[0]?.id ?? null);
      })
      .catch(() => {});
  }, []);

  async function load() {
    if (projectId == null) return;
    setBusy(true);
    try {
      setDocs(await api.get(`/api/documents?project_id=${projectId}`));
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

  async function upload(e) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMsg({ type: 'err', text: 'Dosya seçin.' });
      return;
    }
    const fd = new FormData();
    fd.append('project_id', projectId);
    fd.append('title', form.title);
    fd.append('category', form.category);
    fd.append('revision', form.revision || 'R0');
    fd.append('notes', form.notes);
    fd.append('file', file);
    setBusy(true);
    try {
      const res = await fetch('/api/documents', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + localStorage.getItem('ptyp_token') },
        body: fd,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Yükleme başarısız.');
      setForm({ title: '', category: 'pafta', revision: 'R0', notes: '' });
      fileRef.current.value = '';
      await load();
      setMsg({ type: 'ok', text: 'Belge yüklendi.' });
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function download(doc) {
    try {
      const res = await fetch(`/api/documents/${doc.id}/download`, {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('ptyp_token') },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'İndirme başarısız.');
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = doc.file_name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  async function remove(id) {
    if (!window.confirm('Belge silinsin mi? (Dosya diskten de silinir)')) return;
    try {
      await api.del(`/api/documents/${id}`);
      await load();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Dokümanlar</h1>
          <p className="sub">Pafta, DTL revizyonları ve onay yazıları — projeye bağlı</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
        <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
          PROJE:
        </span>
        <select value={projectId ?? ''} onChange={(e) => setProjectId(Number(e.target.value))}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {msg && (
        <div className={msg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Belge Yükle</h3>
        <form onSubmit={upload}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: '2 1 200px' }}>
              <label>Başlık</label>
              <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="örn. Proje paftası, DTL Rev.1…" required />
            </div>
            <div className="field" style={{ flex: '1 1 140px' }}>
              <label>Kategori</label>
              <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                {Object.entries(CATEGORIES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: '1 1 100px' }}>
              <label>Revizyon</label>
              <input value={form.revision} onChange={(e) => setForm((f) => ({ ...f, revision: e.target.value }))} placeholder="R0" />
            </div>
            <div className="field" style={{ flex: '1 1 180px' }}>
              <label>Not</label>
              <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
            <input ref={fileRef} type="file" required />
            <button type="submit" className="btn btn-primary" disabled={busy || projectId == null}>
              Yükle
            </button>
          </div>
        </form>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Belgeler</h3>
        {docs.length === 0 ? (
          <div className="empty">Bu projede belge yok.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Kategori</th>
                  <th>Başlık</th>
                  <th>Revizyon</th>
                  <th>Dosya</th>
                  <th>Not</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {fmtDate(d.created_at?.slice(0, 10))}
                    </td>
                    <td>
                      <span className={`badge ${CATEGORY_BADGE[d.category] || 'badge-gray'}`}>{CATEGORIES[d.category] || d.category}</span>
                    </td>
                    <td style={{ fontWeight: 600 }}>{d.title}</td>
                    <td>{d.revision}</td>
                    <td className="muted">{d.file_name}</td>
                    <td className="muted">{d.notes || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm" onClick={() => download(d)}>
                        İndir
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => remove(d.id)}>
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
  );
}
