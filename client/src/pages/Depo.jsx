import { useEffect, useState } from 'react';
import { api } from '../api';
import Modal from '../components/Modal';
import { fmtNum, useProjects, ProjectBar } from '../utils';

const MOVEMENT = {
  giris: { label: 'Giriş', cls: 'badge-green' },
  sevk: { label: 'Sevk', cls: 'badge-blue' },
  sarfiyat: { label: 'Sarfiyat', cls: 'badge-amber' },
};

const EMPTY_FORM = {
  movement_type: 'giris',
  material_id: '',
  qty: '',
  unit: '',
  irsaliye_no: '',
  supplier_id: '',
  saha_request_id: '',
  note: '',
};

export default function Depo() {
  const { projects, projectId, setProjectId } = useProjects();
  const [summary, setSummary] = useState([]);
  const [movements, setMovements] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [requests, setRequests] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => {
    api
      .get('/api/materials')
      .then((m) => {
        setMaterials(m);
        setForm((f) => ({ ...f, material_id: m[0]?.id ?? '', unit: m[0]?.unit || 'adet' }));
      })
      .catch(() => {});
    api
      .get('/api/suppliers')
      .then((s) => setSuppliers(s))
      .catch(() => {});
  }, []);

  async function load() {
    if (projectId == null) return;
    setBusy(true);
    try {
      const [s, m, r] = await Promise.all([
        api.get(`/api/stock?project_id=${projectId}`),
        api.get(`/api/stock/movements?project_id=${projectId}`),
        api.get(`/api/stock/requests?project_id=${projectId}`),
      ]);
      setSummary(s.summary || []);
      setMovements(m);
      setRequests(r);
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

  function openNew(type) {
    setForm({
      ...EMPTY_FORM,
      movement_type: type,
      material_id: materials[0]?.id ?? '',
      unit: materials[0]?.unit || 'adet',
    });
    setEditing({});
  }

  function pickMaterial(id) {
    const m = materials.find((x) => x.id === Number(id));
    setForm((f) => ({ ...f, material_id: id, unit: m?.unit || f.unit }));
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/stock/movements', { ...form, project_id: projectId });
      setEditing(null);
      await load();
      setMsg({ type: 'ok', text: 'Hareket kaydedildi.' });
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id) {
    if (!window.confirm('Hareket silinsin mi? (Stok hesabı geri alınır)')) return;
    try {
      await api.del(`/api/stock/movements/${id}`);
      await load();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  function statusBadge(row) {
    if (row.remaining <= 0) return <span className="badge badge-red">Bitti</span>;
    if (row.kesif != null && row.remaining < row.kesif * 0.1) return <span className="badge badge-amber">Kritik</span>;
    if (row.remaining < 0) return <span className="badge badge-red">Eksik</span>;
    return <span className="badge badge-green">Yeterli</span>;
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Depo &amp; Stok</h1>
          <p className="sub">İrsaliye girişi, sahaya sevk, sarfiyat — keşif ile karşılaştırmalı</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-accent" onClick={() => openNew('giris')} disabled={projectId == null || materials.length === 0}>
            + Giriş
          </button>
          <button className="btn" onClick={() => openNew('sevk')} disabled={projectId == null || materials.length === 0}>
            + Sevk
          </button>
          <button className="btn" onClick={() => openNew('sarfiyat')} disabled={projectId == null || materials.length === 0}>
            + Sarfiyat
          </button>
        </div>
      </div>

      <ProjectBar projects={projects} projectId={projectId} onChange={setProjectId} />

      {msg && (
        <div className={msg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Stok Durumu</h3>
        {summary.length === 0 ? (
          <div className="empty">
            Henüz stok hareketi yok. <b>+ Giriş</b> ile irsaliye girişi yapın; keşif miktarıyla karşılaştırma otomatik
            görünür.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kod</th>
                  <th>Malzeme</th>
                  <th>Birim</th>
                  <th className="num">Keşif</th>
                  <th className="num">Gelen</th>
                  <th className="num">Harcanan</th>
                  <th className="num">Kalan</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => (
                  <tr key={r.material_id}>
                    <td className="muted">{r.code || '—'}</td>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td>{r.unit}</td>
                    <td className="num muted">{fmtNum(r.kesif)}</td>
                    <td className="num">{fmtNum(r.total_in)}</td>
                    <td className="num">{fmtNum(r.total_out)}</td>
                    <td className="num" style={{ fontWeight: 700 }}>
                      {fmtNum(r.remaining)}
                    </td>
                    <td>{statusBadge(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Son Hareketler</h3>
        {movements.length === 0 ? (
          <div className="empty">Hareket kaydı yok.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Tip</th>
                  <th>Malzeme</th>
                  <th className="num">Miktar</th>
                  <th>İrsaliye</th>
                  <th>Tedarikçi</th>
                  <th>Talep</th>
                  <th>Not</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => {
                  const t = MOVEMENT[m.movement_type] || MOVEMENT.giris;
                  return (
                    <tr key={m.id}>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {new Date(m.created_at).toLocaleString('tr-TR')}
                      </td>
                      <td>
                        <span className={`badge ${t.cls}`}>{t.label}</span>
                      </td>
                      <td style={{ fontWeight: 600 }}>{m.material_name}</td>
                      <td className="num">
                        {fmtNum(m.qty)} {m.unit}
                      </td>
                      <td>{m.irsaliye_no || '—'}</td>
                      <td>{m.supplier_name || '—'}</td>
                      <td>{m.request_item || '—'}</td>
                      <td className="muted">{m.note || '—'}</td>
                      <td>
                        <button className="btn btn-sm btn-danger" onClick={() => remove(m.id)}>
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

      {editing && (
        <Modal title={`Yeni ${MOVEMENT[form.movement_type].label}`} onClose={() => setEditing(null)}>
          <form onSubmit={save}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div className="field" style={{ flex: '2 1 180px' }}>
                <label>Malzeme</label>
                <select value={form.material_id} onChange={(e) => pickMaterial(e.target.value)}>
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.code ? `${m.code} — ` : ''}
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: '1 1 110px' }}>
                <label>Miktar</label>
                <input type="number" step="any" min="0" value={form.qty} onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))} required />
              </div>
              <div className="field" style={{ flex: '1 1 100px' }}>
                <label>Birim</label>
                <input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} />
              </div>
              {form.movement_type === 'giris' && (
                <>
                  <div className="field" style={{ flex: '1 1 130px' }}>
                    <label>İrsaliye No</label>
                    <input value={form.irsaliye_no} onChange={(e) => setForm((f) => ({ ...f, irsaliye_no: e.target.value }))} />
                  </div>
                  <div className="field" style={{ flex: '1 1 150px' }}>
                    <label>Tedarikçi</label>
                    <select value={form.supplier_id} onChange={(e) => setForm((f) => ({ ...f, supplier_id: e.target.value }))}>
                      <option value="">—</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}
              {form.movement_type === 'sevk' && (
                <div className="field" style={{ flex: '1 1 150px' }}>
                  <label>Saha Talebi</label>
                  <select value={form.saha_request_id} onChange={(e) => setForm((f) => ({ ...f, saha_request_id: e.target.value }))}>
                    <option value="">—</option>
                    {requests.map((r) => (
                      <option key={r.id} value={r.id}>
                        #{r.id} {r.item_name} ({fmtNum(r.qty)} {r.unit})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label>Not</label>
              <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="Araç plakası, teslim alan vb." />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
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
