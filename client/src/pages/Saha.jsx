import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, getToken } from '../api';
import { useAuth } from '../AuthContext';
import { loadLeaflet, useProjects } from '../utils';

// Oturumlu fotoğraf: token ile fetch → blob URL (img etiketi Authorization gönderemez)
function PhotoImg({ url }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(url, { headers: { Authorization: 'Bearer ' + getToken() } });
        if (!res.ok) return;
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        if (alive) setSrc(objectUrl);
      } catch {
        /* sessiz */
      }
    })();
    return () => {
      alive = false;
    };
  }, [url]);
  if (!src) return <span className="photo-thumb photo-loading">…</span>;
  return <img src={src} className="photo-thumb" alt="" />;
}

export default function Saha() {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const [params] = useSearchParams();
  const pathParams = useParams(); // /saha/direk/:proje/:direk (QR akışı — proxy query soyduğu için)
  const qProje = params.get('proje') ?? pathParams.proje;
  const focusIdx = params.get('direk') ?? pathParams.direk;
  const { projects, projectId, setProjectId } = useProjects(qProje);
  const [data, setData] = useState(null); // { project_name, poles, statuses, summary }
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [filter, setFilter] = useState('all');
  const [uploadPole, setUploadPole] = useState(null); // fotoğraf eklenen direk
  const [flashIdx, setFlashIdx] = useState(null); // QR ile odaklanan direk
  const [tab, setTab] = useState('poles'); // poles | requests
  const [requests, setRequests] = useState([]);
  const [reqForm, setReqForm] = useState({ item_name: '', qty: '1', unit: 'adet', pole_ref: '', needed_by: '', note: '' });
  const mapDivRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const layerRef = useRef(null);
  const fileRef = useRef(null);

  async function load() {
    if (projectId == null) return;
    setBusy(true);
    setMsg(null);
    try {
      const d = await api.get(`/api/saha/${projectId}`);
      setData(d);
      if (focusIdx != null) setFilter('all'); // QR ile gelen direk gizlenmesin
    } catch (e) {
      setData(null);
      setMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  // QR/bağlantı ile gelen direğe odaklan
  useEffect(() => {
    if (!data || focusIdx == null) return;
    const el = document.getElementById(`pole-row-${focusIdx}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashIdx(Number(focusIdx));
      const t = setTimeout(() => setFlashIdx(null), 2600);
      return () => clearTimeout(t);
    }
  }, [data, focusIdx]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Harita: tile + güzergah çizgisi + durum renkli direkler
  useEffect(() => {
    if (!data || !mapDivRef.current) return;
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
      const pts = data.poles
        .filter((p) => filter === 'all' || p.status === filter)
        .map((p) => [p.lat, p.lon]);
      if (pts.length > 1) {
        L.polyline(pts, { color: '#64748b', weight: 2.5, dashArray: '4 5' }).addTo(layer);
      }
      for (const p of data.poles) {
        if (filter !== 'all' && p.status !== filter) continue;
        const st = data.statuses[p.status] || data.statuses.none;
        const m = L.circleMarker([p.lat, p.lon], {
          radius: 8,
          color: '#ffffff',
          weight: 1.5,
          fillColor: st.color,
          fillOpacity: 0.95,
        }).addTo(layer);
        m.bindPopup(
          `<b>${p.name}</b><br>${p.tower_type || '—'}` +
            (p.station_text ? ` · ${p.station_text}` : '') +
            `<br>Durum: ${st.label}`
        );
      }
      if (pts.length > 0) map.fitBounds(L.latLngBounds(pts.map((x) => [x[0], x[1]])).pad(0.15));
    })();
  }, [data, filter]);

  async function saveStatus(idx, status, note) {
    try {
      const d = await api.put(`/api/saha/${projectId}/status`, {
        pole_idx: idx,
        status,
        note: note ?? '',
      });
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          poles: prev.poles.map((p) => (p.idx === idx ? { ...p, status: d.status, status_label: d.status_label, note: d.note } : p)),
        };
      });
      setMsg({ type: 'ok', text: `${pName(idx)} güncellendi.` });
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  function pName(idx) {
    return (data?.poles.find((p) => p.idx === idx)?.name) || `D-${idx}`;
  }

  async function uploadPhotos() {
    if (uploadPole == null || !fileRef.current?.files?.length) return;
    const fd = new FormData();
    fd.append('pole_idx', uploadPole);
    for (const f of fileRef.current.files) fd.append('photos', f);
    try {
      await api.upload(`/api/saha/${projectId}/photos`, fd);
      await load();
      setMsg({ type: 'ok', text: `${pName(uploadPole)} için fotoğraf eklendi.` });
    } catch (e) {
      setMsg({ type: 'err', text: 'Fotoğraf yüklenemedi: ' + (e.message || 'hata') });
    } finally {
      fileRef.current.value = '';
      setUploadPole(null);
    }
  }

  async function deletePhoto(photoId) {
    if (!window.confirm('Fotoğraf silinsin mi?')) return;
    try {
      await api.del(`/api/saha/photos/${photoId}`);
      await load();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  async function openQr() {
    if (projectId == null) return;
    try {
      const res = await fetch(`/api/saha/${projectId}/qr`, {
        headers: { Authorization: 'Bearer ' + getToken() },
      });
      if (!res.ok) throw new Error('QR sayfası üretilemedi.');
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  async function loadRequests() {
    if (projectId == null) return;
    try {
      setRequests(await api.get(`/api/saha/${projectId}/requests`));
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  useEffect(() => {
    if (tab === 'requests') loadRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, projectId]);

  async function submitRequest(e) {
    e.preventDefault();
    if (!reqForm.item_name.trim()) {
      setMsg({ type: 'err', text: 'Malzeme adı zorunludur.' });
      return;
    }
    try {
      await api.post(`/api/saha/${projectId}/requests`, reqForm);
      setReqForm({ item_name: '', qty: '1', unit: 'adet', pole_ref: '', needed_by: '', note: '' });
      await loadRequests();
      setMsg({ type: 'ok', text: 'Talep iletildi.' });
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    }
  }

  async function setReqStatus(id, status) {
    try {
      await api.put(`/api/saha/requests/${id}/status`, { status });
      await loadRequests();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    }
  }

  const summary = data?.summary;
  const statuses = data?.statuses || {};
  const openCount = requests.filter((r) => r.status === 'open').length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Saha</h1>
          <p className="sub">Direk bazlı ilerleme ve saha fotoğrafları</p>
        </div>
        <button className="btn" onClick={openQr} disabled={projectId == null} title="Direk QR kartlarını yazdırmak için">
          QR Çıktısı
        </button>
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
        {summary && (
          <>
            <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
              İLERLEME:
            </span>
            <div className="progress-track mini" style={{ width: 160 }}>
              <div className="progress-fill" style={{ width: `${summary.progress}%` }} />
            </div>
            <span style={{ fontWeight: 700, fontSize: 13 }}>%{summary.progress}</span>
            <span className="muted" style={{ fontSize: 12 }}>
              ({summary.pole_count} direk)
            </span>
          </>
        )}
      </div>

      {msg && (
        <div className={msg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <button className={`tab-chip ${tab === 'poles' ? 'on' : ''}`} onClick={() => setTab('poles')}>
              Direkler
            </button>
            <button className={`tab-chip ${tab === 'requests' ? 'on' : ''}`} onClick={() => setTab('requests')}>
              Talepler{openCount > 0 ? ` (${openCount})` : ''}
            </button>
          </div>

          {tab === 'poles' && (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <button
              className={`tab-chip ${filter === 'all' ? 'on' : ''}`}
              onClick={() => setFilter('all')}
            >
              Tümü
            </button>
            {summary.status_counts.map((s) => (
              <button
                key={s.status}
                className={`tab-chip ${filter === s.status ? 'on' : ''}`}
                style={{ borderColor: s.color, color: filter === s.status ? '#fff' : s.color }}
                onClick={() => setFilter(filter === s.status ? 'all' : s.status)}
              >
                {s.label} ({s.count})
              </button>
            ))}
          </div>

          <div className="card" style={{ marginBottom: 14, padding: 10 }}>
            <div ref={mapDivRef} className="saha-map" />
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Direkler</h3>
            {data.poles
              .filter((p) => filter === 'all' || p.status === filter)
              .map((p) => {
                const st = statuses[p.status] || statuses.none;
                return (
                  <div key={p.idx} id={`pole-row-${p.idx}`} className={`pole-row ${flashIdx === p.idx ? 'flash' : ''}`}>
                    <div className="pole-info">
                      <b>{p.name}</b>
                      <span className="muted">
                        {p.tower_type || '—'}
                        {p.station_text ? ` · ${p.station_text}` : ''}
                      </span>
                      {p.updated_by && (
                        <span className="muted" style={{ fontSize: 10.5 }}>
                          {p.updated_by}
                        </span>
                      )}
                    </div>
                    <div className="pole-actions">
                      <select
                        value={p.status}
                        onChange={(e) => saveStatus(p.idx, e.target.value, p.note)}
                        style={{ borderColor: st.color, color: st.color, fontWeight: 600 }}
                      >
                        {Object.entries(statuses).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setUploadPole(p.idx);
                          fileRef.current?.click();
                        }}
                      >
                        Fotoğraf ({p.photos.length})
                      </button>
                    </div>
                    <div className="pole-note">
                      <input
                        value={p.note}
                        placeholder="Not ekle…"
                        onBlur={(e) => {
                          if (e.target.value !== p.note) saveStatus(p.idx, p.status, e.target.value);
                        }}
                        onChange={(e) =>
                          setData((prev) => ({
                            ...prev,
                            poles: prev.poles.map((x) => (x.idx === p.idx ? { ...x, note: e.target.value } : x)),
                          }))
                        }
                      />
                    </div>
                    {p.photos.length > 0 && (
                      <div className="pole-photos">
                        {p.photos.map((ph) => (
                          <span key={ph.id} className="photo-wrap" title={ph.caption || 'Fotoğraf'}>
                            <PhotoImg url={ph.url} />
                            <button
                              className="photo-del"
                              title="Sil"
                              onClick={() => deletePhoto(ph.id)}
                            >
                              ✕
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            {data.poles.length === 0 && (
              <div className="empty">
                Bu projede direk yok. Önce <b>Belge → KMZ</b> sayfasından güzergah üretin.
              </div>
            )}
          </div>
            </>
          )}

          {tab === 'requests' && (
            <>
              <div className="card" style={{ marginBottom: 14 }}>
                <h3 style={{ marginTop: 0 }}>Malzeme Talebi Gönder</h3>
                <form onSubmit={submitRequest} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                  <div className="field" style={{ flex: '2 1 220px', marginBottom: 0 }}>
                    <label>Malzeme *</label>
                    <input
                      value={reqForm.item_name}
                      onChange={(e) => setReqForm((f) => ({ ...f, item_name: e.target.value }))}
                      placeholder="örn: PB1 tipi beton direk"
                    />
                  </div>
                  <div className="field" style={{ flex: '0 1 90px', marginBottom: 0 }}>
                    <label>Miktar</label>
                    <input
                      type="number"
                      step="any"
                      value={reqForm.qty}
                      onChange={(e) => setReqForm((f) => ({ ...f, qty: e.target.value }))}
                    />
                  </div>
                  <div className="field" style={{ flex: '0 1 110px', marginBottom: 0 }}>
                    <label>Birim</label>
                    <select value={reqForm.unit} onChange={(e) => setReqForm((f) => ({ ...f, unit: e.target.value }))}>
                      {['adet', 'm', 'kg', 'ton', 'takım', 'torba', 'm3'].map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field" style={{ flex: '1 1 140px', marginBottom: 0 }}>
                    <label>Direk / Kesim</label>
                    <input
                      value={reqForm.pole_ref}
                      onChange={(e) => setReqForm((f) => ({ ...f, pole_ref: e.target.value }))}
                      placeholder="örn: D-14..D-20"
                    />
                  </div>
                  <div className="field" style={{ flex: '0 1 140px', marginBottom: 0 }}>
                    <label>Gerekli Tarih</label>
                    <input
                      type="date"
                      value={reqForm.needed_by}
                      onChange={(e) => setReqForm((f) => ({ ...f, needed_by: e.target.value }))}
                    />
                  </div>
                  <button className="btn btn-accent" type="submit">
                    Gönder
                  </button>
                </form>
              </div>

              <div className="card">
                <h3 style={{ marginTop: 0 }}>Talepler</h3>
                {requests.length === 0 ? (
                  <div className="empty">Henüz talep yok.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Malzeme</th>
                          <th className="num">Miktar</th>
                          <th>Direk / Kesim</th>
                          <th>Gerekli</th>
                          <th>İsteyen</th>
                          <th>Durum</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {requests.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <b>{r.item_name}</b>
                              {r.note && <div className="muted" style={{ fontSize: 11.5 }}>{r.note}</div>}
                            </td>
                            <td className="num">
                              {r.qty} {r.unit}
                            </td>
                            <td>{r.pole_ref || '—'}</td>
                            <td className="muted">{r.needed_by || '—'}</td>
                            <td className="muted">{r.requested_by_name || '—'}</td>
                            <td>
                              {r.status === 'open' ? (
                                <span className="badge badge-amber">Bekliyor</span>
                              ) : r.status === 'fulfilled' ? (
                                <span className="badge badge-green">Karşılandı</span>
                              ) : (
                                <span className="badge badge-gray">İptal</span>
                              )}
                            </td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              {r.status === 'open' && isOwner && (
                                <button className="btn btn-sm btn-success" onClick={() => setReqStatus(r.id, 'fulfilled')}>
                                  Karşılandı
                                </button>
                              )}
                              {r.status === 'open' && (
                                <button className="btn btn-sm btn-danger" onClick={() => setReqStatus(r.id, 'cancelled')}>
                                  İptal
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            style={{ display: 'none' }}
            onChange={uploadPhotos}
          />
        </>
      )}

      {!data && !busy && (
        <div className="empty">Bu projede gösterilecek veri yok.</div>
      )}
    </div>
  );
}
