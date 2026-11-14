import { useEffect, useState } from 'react';
import { api } from '../api';
import Modal from '../components/Modal';
import { UNITS, fmtNum, useProjects, ProjectBar } from '../utils';

const MOVEMENT = {
  giris: { label: 'Giriş', cls: 'badge-green' },
  sevk: { label: 'Sevk', cls: 'badge-blue' },
  sarfiyat: { label: 'Sarfiyat', cls: 'badge-amber' },
};

const EMPTY_FORM = {
  movement_type: 'giris',
  material_id: '',
  new_material_name: '',
  new_material_code: '',
  qty: '',
  unit: 'adet',
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
      .get('/api/suppliers')
      .then((s) => setSuppliers(s))
      .catch(() => {});
  }, []);

  async function load() {
    if (projectId == null) return;
    setBusy(true);
    try {
      const [s, m, r, matList] = await Promise.all([
        api.get(`/api/stock?project_id=${projectId}`),
        api.get(`/api/stock/movements?project_id=${projectId}`),
        api.get(`/api/stock/requests?project_id=${projectId}`),
        api.get('/api/materials').catch(() => null),
      ]);
      const mats = s.materials || matList || [];
      setSummary(s.summary || []);
      setMaterials(mats);
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

  async function syncFromKesif() {
    if (projectId == null) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.post('/api/stock/sync-kesif', { project_id: projectId });
      await load();
      setMsg({
        type: 'ok',
        text:
          res.added > 0
            ? `Keşif / DTL verisinden ${res.added} yeni malzeme stok listesine eklendi.`
            : 'Tüm keşif kalemleri zaten malzeme listesinde mevcut.',
      });
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  function openNew(type, prefill = {}) {
    const defaultMatId = prefill.material_id ?? (materials[0]?.id ? String(materials[0].id) : 'new');
    const selectedMat = materials.find((x) => String(x.id) === String(defaultMatId));
    setForm({
      ...EMPTY_FORM,
      movement_type: type,
      material_id: defaultMatId,
      unit: prefill.unit || selectedMat?.unit || 'adet',
      qty: prefill.qty != null ? String(prefill.qty) : '',
      saha_request_id: prefill.saha_request_id != null ? String(prefill.saha_request_id) : '',
      new_material_name: prefill.new_material_name || '',
      note: prefill.note || '',
    });
    setEditing({});
  }

  function pickMaterial(id) {
    if (id === 'new') {
      setForm((f) => ({ ...f, material_id: 'new' }));
      return;
    }
    const m = materials.find((x) => String(x.id) === String(id));
    setForm((f) => ({ ...f, material_id: id, unit: m?.unit || f.unit }));
  }

  function pickRequest(reqId) {
    const r = requests.find((x) => String(x.id) === String(reqId));
    if (!r) {
      setForm((f) => ({ ...f, saha_request_id: reqId }));
      return;
    }
    const matchedMat = materials.find(
      (m) => m.name.toLowerCase().trim() === String(r.item_name || '').toLowerCase().trim()
    );
    setForm((f) => ({
      ...f,
      saha_request_id: reqId,
      material_id: matchedMat ? String(matchedMat.id) : f.material_id,
      qty: f.qty || String(r.qty || ''),
      unit: r.unit || matchedMat?.unit || f.unit,
      note: f.note || (r.pole_ref ? `Direk: ${r.pole_ref}` : ''),
    }));
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const payload = {
        ...form,
        project_id: projectId,
        material_id: form.material_id === 'new' ? null : Number(form.material_id),
      };
      await api.post('/api/stock/movements', payload);
      setEditing(null);
      await load();
      setMsg({ type: 'ok', text: 'Stok hareketi kaydedildi.' });
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
    if (row.remaining < 0) return <span className="badge badge-red">Eksik</span>;
    if ((Number(row.total_in) || 0) === 0 && (Number(row.total_out) || 0) === 0) {
      return <span className="badge badge-gray">Giriş Yok</span>;
    }
    if (row.remaining === 0) return <span className="badge badge-red">Bitti</span>;
    if (row.kesif != null && row.kesif > 0 && row.remaining < row.kesif * 0.1) {
      return <span className="badge badge-amber">Kritik</span>;
    }
    return <span className="badge badge-green">Yeterli</span>;
  }

  const openRequests = requests.filter((r) => r.status === 'open');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Depo &amp; Stok</h1>
          <p className="sub">İrsaliye girişi, sahaya sevk, sarfiyat — keşif ile karşılaştırmalı</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn"
            onClick={syncFromKesif}
            disabled={projectId == null || busy}
            title="Keşif / DTL kalemlerini malzeme ve stok listesine aktarır"
          >
            Keşiften Eşitle
          </button>
          <button className="btn btn-accent" onClick={() => openNew('giris')} disabled={projectId == null}>
            + Giriş
          </button>
          <button className="btn" onClick={() => openNew('sevk')} disabled={projectId == null}>
            + Sevk
          </button>
          <button className="btn" onClick={() => openNew('sarfiyat')} disabled={projectId == null}>
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

      {openRequests.length > 0 && (
        <div className="card" style={{ marginBottom: 14, borderLeft: '4px solid #2563eb' }}>
          <h3 style={{ marginTop: 0, marginBottom: 8 }}>Bekleyen Saha Malzeme Talepleri ({openRequests.length})</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Malzeme / Kalem</th>
                  <th className="num">Miktar</th>
                  <th>Direk / Bölge</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {openRequests.map((r) => {
                  const matchedMat = materials.find(
                    (m) => m.name.toLowerCase().trim() === String(r.item_name || '').toLowerCase().trim()
                  );
                  return (
                    <tr key={r.id}>
                      <td className="muted">#{r.id}</td>
                      <td style={{ fontWeight: 600 }}>{r.item_name}</td>
                      <td className="num">
                        {fmtNum(r.qty)} {r.unit}
                      </td>
                      <td>{r.pole_ref || '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn btn-sm btn-accent"
                          onClick={() =>
                            openNew('sevk', {
                              saha_request_id: r.id,
                              material_id: matchedMat ? String(matchedMat.id) : 'new',
                              new_material_name: matchedMat ? '' : r.item_name,
                              qty: r.qty,
                              unit: r.unit || 'adet',
                              note: r.pole_ref ? `Direk: ${r.pole_ref}` : '',
                            })
                          }
                        >
                          Sevk Et
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Stok Durumu</h3>
        {summary.length === 0 ? (
          <div className="empty">
            Henüz tanımlı malzeme veya stok hareketi yok. <b>+ Giriş</b> ile yeni malzeme ve irsaliye girişi yapabilir
            veya <b>Keşiften Eşitle</b> ile DTL/Keşif kalemlerini aktarabilirsiniz.
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
                  <th>Hızlı İşlem</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => (
                  <tr key={r.material_id}>
                    <td className="muted">{r.code || '—'}</td>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td>{r.unit}</td>
                    <td className="num muted">{r.kesif != null ? fmtNum(r.kesif) : '—'}</td>
                    <td className="num">{fmtNum(r.total_in)}</td>
                    <td className="num">{fmtNum(r.total_out)}</td>
                    <td className="num" style={{ fontWeight: 700 }}>
                      {fmtNum(r.remaining)}
                    </td>
                    <td>{statusBadge(r)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        className="btn btn-sm"
                        onClick={() => openNew('giris', { material_id: String(r.material_id), unit: r.unit })}
                        title="İrsaliye girişi ekle"
                      >
                        + Giriş
                      </button>{' '}
                      <button
                        className="btn btn-sm"
                        onClick={() => openNew('sevk', { material_id: String(r.material_id), unit: r.unit })}
                        title="Sahaya sevk et"
                      >
                        Sevk
                      </button>{' '}
                      <button
                        className="btn btn-sm"
                        onClick={() => openNew('sarfiyat', { material_id: String(r.material_id), unit: r.unit })}
                        title="Sarfiyat düş"
                      >
                        Sarf
                      </button>
                    </td>
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
              <div className="field" style={{ flex: '2 1 200px' }}>
                <label>Malzeme</label>
                <select value={form.material_id} onChange={(e) => pickMaterial(e.target.value)}>
                  {materials.map((m) => (
                    <option key={m.id} value={String(m.id)}>
                      {m.code ? `${m.code} — ` : ''}
                      {m.name}
                    </option>
                  ))}
                  <option value="new">+ Yeni Malzeme Tanımla…</option>
                </select>
              </div>
              {form.material_id === 'new' && (
                <>
                  <div className="field" style={{ flex: '2 1 200px' }}>
                    <label>Yeni Malzeme Adı *</label>
                    <input
                      value={form.new_material_name}
                      onChange={(e) => setForm((f) => ({ ...f, new_material_name: e.target.value }))}
                      placeholder="Örn: 3A Tipi Direk / HAWK İletken"
                      required
                    />
                  </div>
                  <div className="field" style={{ flex: '1 1 110px' }}>
                    <label>Kod (Opsiyonel)</label>
                    <input
                      value={form.new_material_code}
                      onChange={(e) => setForm((f) => ({ ...f, new_material_code: e.target.value }))}
                      placeholder="Otomatik"
                    />
                  </div>
                </>
              )}
              <div className="field" style={{ flex: '1 1 110px' }}>
                <label>Miktar *</label>
                <input
                  type="number"
                  step="any"
                  min="0.001"
                  value={form.qty}
                  onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))}
                  required
                />
              </div>
              <div className="field" style={{ flex: '1 1 100px' }}>
                <label>Birim</label>
                <select value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}>
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
              {form.movement_type === 'giris' && (
                <>
                  <div className="field" style={{ flex: '1 1 130px' }}>
                    <label>İrsaliye No</label>
                    <input
                      value={form.irsaliye_no}
                      onChange={(e) => setForm((f) => ({ ...f, irsaliye_no: e.target.value }))}
                    />
                  </div>
                  <div className="field" style={{ flex: '1 1 150px' }}>
                    <label>Tedarikçi</label>
                    <select
                      value={form.supplier_id}
                      onChange={(e) => setForm((f) => ({ ...f, supplier_id: e.target.value }))}
                    >
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
                <div className="field" style={{ flex: '1 1 180px' }}>
                  <label>Saha Talebi</label>
                  <select value={form.saha_request_id} onChange={(e) => pickRequest(e.target.value)}>
                    <option value="">—</option>
                    {requests.map((r) => (
                      <option key={r.id} value={r.id}>
                        #{r.id} {r.item_name} ({fmtNum(r.qty)} {r.unit}) {r.status === 'fulfilled' ? '✓' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label>Not</label>
              <input
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="Araç plakası, teslim alan vb."
              />
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
