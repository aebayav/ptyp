import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import Modal from '../components/Modal';
import { loadLeaflet, useProjects, ProjectBar } from '../utils';

const EASEMENT = {
  belirsiz: { label: 'Belirsiz', color: '#94a3b8' },
  basvuruda: { label: 'Başvuruda', color: '#d97706' },
  izinli: { label: 'İzinli', color: '#16a34a' },
  izinsiz: { label: 'İzinsiz', color: '#dc2626' },
};

const LEGAL = {
  yok: { label: '—' },
  anlasma: { label: 'Anlaşma', cls: 'badge-green' },
  dava: { label: 'Dava', cls: 'badge-amber' },
  kamulastirma: { label: 'Kamulaştırma', cls: 'badge-blue' },
};

const EMPTY_FORM = {
  pole_from_idx: '',
  pole_to_idx: '',
  parcel_no: '',
  owner_name: '',
  easement_status: 'belirsiz',
  legal_status: 'yok',
  price: '',
  notes: '',
};

export default function Kamulastirma() {
  const { projects, projectId, setProjectId } = useProjects();
  const [poles, setPoles] = useState([]);
  const [parcels, setParcels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null); // null | {id?, form}
  const [form, setForm] = useState(EMPTY_FORM);
  const mapDivRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const layerRef = useRef(null);

  async function load() {
    if (projectId == null) return;
    setBusy(true);
    try {
      const [p, q] = await Promise.all([
        api.get(`/api/parcels/poles?project_id=${projectId}`),
        api.get(`/api/parcels?project_id=${projectId}`),
      ]);
      setPoles(p);
      setParcels(q);
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

  // Harita: direk noktaları + açıklık çizgileri (irtifak durumuna göre renkli)
  useEffect(() => {
    if (poles.length < 2 || !mapDivRef.current) return;
    (async () => {
      const L = await loadLeaflet();
      if (!mapInstanceRef.current) {
        const map = L.map(mapDivRef.current, {});
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Tiles © Esri',
          maxZoom: 19,
        }).addTo(map);
        layerRef.current = L.layerGroup().addTo(map);
        mapInstanceRef.current = map;
      }
      const map = mapInstanceRef.current;
      const layer = layerRef.current;
      layer.clearLayers();

      // Açıklık çizgileri
      for (let k = 0; k < poles.length - 1; k++) {
        const a = poles[k];
        const b = poles[k + 1];
        const par = parcels.find((p) => p.pole_from_idx <= k && p.pole_to_idx >= k + 1);
        const st = EASEMENT[par?.easement_status] || EASEMENT.belirsiz;
        if (filter !== 'all' && (!par || par.easement_status !== filter)) continue;
        const popup =
          par && par.parcel_no
            ? `<b>${par.parcel_no || '—'}</b><br>Malik: ${par.owner_name || '—'}<br>İrtifak: ${st.label}` +
              (par.legal_status !== 'yok' ? `<br>Durum: ${LEGAL[par.legal_status].label}` : '') +
              (par.price != null ? `<br>Bedel: ${Number(par.price).toLocaleString('tr-TR')} ₺` : '')
            : 'Parsel kaydı yok';
        const line = L.polyline(
          [
            [a.lat, a.lon],
            [b.lat, b.lon],
          ],
          { color: st.color, weight: 3.5, opacity: 0.85 }
        ).addTo(layer);
        line.bindPopup(popup);
      }
      // Direk noktaları
      for (const p of poles) {
        L.circleMarker([p.lat, p.lon], {
          radius: 4,
          color: '#ffffff',
          weight: 1,
          fillColor: '#33475c',
          fillOpacity: 0.9,
        })
          .bindPopup(`<b>${p.name}</b>${p.tower_type ? `<br>${p.tower_type}` : ''}`)
          .addTo(layer);
      }
      map.fitBounds(
        L.latLngBounds(poles.map((p) => [p.lat, p.lon])).pad(0.15)
      );
    })();
  }, [poles, parcels, filter]);

  function openNew() {
    if (poles.length >= 2) {
      setForm({ ...EMPTY_FORM, pole_from_idx: String(poles[0].idx), pole_to_idx: String(poles[1].idx) });
    } else {
      setForm(EMPTY_FORM);
    }
    setEditing({});
  }

  function openEdit(p) {
    setForm({
      pole_from_idx: String(p.pole_from_idx),
      pole_to_idx: String(p.pole_to_idx),
      parcel_no: p.parcel_no || '',
      owner_name: p.owner_name || '',
      easement_status: p.easement_status,
      legal_status: p.legal_status,
      price: p.price != null ? String(p.price) : '',
      notes: p.notes || '',
    });
    setEditing({ id: p.id });
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...form, project_id: projectId };
      if (editing?.id) {
        await api.put(`/api/parcels/${editing.id}`, body);
      } else {
        await api.post('/api/parcels', body);
      }
      setEditing(null);
      await load();
      setMsg({ type: 'ok', text: 'Parsel kaydı güncellendi.' });
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id) {
    if (!window.confirm('Parsel kaydı silinsin mi?')) return;
    try {
      await api.del(`/api/parcels/${id}`);
      await load();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  const counts = Object.keys(EASEMENT).reduce((acc, k) => {
    acc[k] = parcels.filter((p) => p.easement_status === k).length;
    return acc;
  }, {});

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Kamulaştırma</h1>
          <p className="sub">Açıklık bazında parsel, malik ve irtifak takibi</p>
        </div>
        <button className="btn btn-accent" onClick={openNew} disabled={poles.length < 2 || projectId == null}>
          + Parsel Ekle
        </button>
      </div>

      <ProjectBar projects={projects} projectId={projectId} onChange={setProjectId}>
        <span className="muted" style={{ fontSize: 12 }}>
          ({poles.length} direk · {Math.max(0, poles.length - 1)} açıklık)
        </span>
      </ProjectBar>

      {msg && (
        <div className={msg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {poles.length >= 2 && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <button className={`tab-chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
              Tümü
            </button>
            {Object.entries(EASEMENT).map(([k, v]) => (
              <button
                key={k}
                className={`tab-chip ${filter === k ? 'on' : ''}`}
                style={{ borderColor: v.color, color: filter === k ? '#fff' : v.color }}
                onClick={() => setFilter(filter === k ? 'all' : k)}
              >
                {v.label} ({counts[k]})
              </button>
            ))}
          </div>

          <div className="card" style={{ marginBottom: 14, padding: 10 }}>
            <div ref={mapDivRef} className="saha-map" />
          </div>
        </>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Parsel Kayıtları</h3>
        {parcels.length === 0 ? (
          <div className="empty">
            Henüz parsel kaydı yok. <b>+ Parsel Ekle</b> ile açıklık bazında kayıt oluşturun — izinsiz parseller
            haritada kırmızı görünür.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Açıklık</th>
                  <th>Parsel No</th>
                  <th>Malik</th>
                  <th>İrtifak</th>
                  <th>Yasal Durum</th>
                  <th className="num">Bedel (₺)</th>
                  <th>Notlar</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {parcels.map((p) => {
                  const st = EASEMENT[p.easement_status] || EASEMENT.belirsiz;
                  const lg = LEGAL[p.legal_status] || LEGAL.yok;
                  return (
                    <tr key={p.id}>
                      <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                        {p.pole_from_name || `D-${p.pole_from_idx}`} → {p.pole_to_name || `D-${p.pole_to_idx}`}
                      </td>
                      <td>{p.parcel_no || '—'}</td>
                      <td>{p.owner_name || '—'}</td>
                      <td>
                        <span className="badge" style={{ background: st.color, color: '#fff' }}>
                          {st.label}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${lg.cls || 'badge-gray'}`}>{lg.label}</span>
                      </td>
                      <td className="num">{p.price != null ? Number(p.price).toLocaleString('tr-TR') : '—'}</td>
                      <td className="muted">{p.notes || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-sm" onClick={() => openEdit(p)}>
                          Düzenle
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => remove(p.id)}>
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
        <Modal title={editing.id ? 'Parsel Düzenle' : 'Yeni Parsel'} onClose={() => setEditing(null)}>
          <form onSubmit={save}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div className="field" style={{ flex: '1 1 140px' }}>
                <label>Başlangıç Direği</label>
                <select value={form.pole_from_idx} onChange={(e) => setForm((f) => ({ ...f, pole_from_idx: e.target.value }))}>
                  {poles.map((p) => (
                    <option key={p.idx} value={p.idx}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: '1 1 140px' }}>
                <label>Bitiş Direği</label>
                <select value={form.pole_to_idx} onChange={(e) => setForm((f) => ({ ...f, pole_to_idx: e.target.value }))}>
                  {poles.map((p) => (
                    <option key={p.idx} value={p.idx}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: '1 1 120px' }}>
                <label>Parsel No</label>
                <input value={form.parcel_no} onChange={(e) => setForm((f) => ({ ...f, parcel_no: e.target.value }))} placeholder="123/45" />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
              <div className="field" style={{ flex: '2 1 200px' }}>
                <label>Malik</label>
                <input value={form.owner_name} onChange={(e) => setForm((f) => ({ ...f, owner_name: e.target.value }))} placeholder="Ad Soyad / Kurum" />
              </div>
              <div className="field" style={{ flex: '1 1 140px' }}>
                <label>İrtifak Durumu</label>
                <select value={form.easement_status} onChange={(e) => setForm((f) => ({ ...f, easement_status: e.target.value }))}>
                  {Object.entries(EASEMENT).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: '1 1 140px' }}>
                <label>Yasal Durum</label>
                <select value={form.legal_status} onChange={(e) => setForm((f) => ({ ...f, legal_status: e.target.value }))}>
                  {Object.entries(LEGAL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: '1 1 120px' }}>
                <label>Bedel (₺)</label>
                <input type="number" step="any" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} />
              </div>
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label>Notlar</label>
              <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Görüşme notu, engel vb." />
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
