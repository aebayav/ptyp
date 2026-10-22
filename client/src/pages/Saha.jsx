import { useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api';

// Leaflet'i RouteMap'teki gibi dinamik yükle (yalnız bir kez)
let leafletReady = null;
function loadLeaflet() {
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((resolve) => {
    if (window.L) return resolve(window.L);
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => resolve(window.L);
    document.head.appendChild(js);
  });
  return leafletReady;
}

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
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [data, setData] = useState(null); // { project_name, poles, statuses, summary }
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [filter, setFilter] = useState('all');
  const [uploadPole, setUploadPole] = useState(null); // fotoğraf eklenen direk
  const mapDivRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const layerRef = useRef(null);
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
    setMsg(null);
    try {
      const d = await api.get(`/api/saha/${projectId}`);
      setData(d);
    } catch (e) {
      setData(null);
      setMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

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
      await fetch(`/api/saha/${projectId}/photos`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: fd,
      });
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

  const summary = data?.summary;
  const statuses = data?.statuses || {};

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Saha</h1>
          <p className="sub">Direk bazlı ilerleme ve saha fotoğrafları</p>
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
                  <div key={p.idx} className="pole-row">
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
