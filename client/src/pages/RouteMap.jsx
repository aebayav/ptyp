import { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiDownload, getToken } from '../api';
import { fmtDate } from '../utils';

let leafletLoaded = false;

function loadLeaflet() {
  return new Promise((resolve, reject) => {
    if (window.L) return resolve(window.L);
    if (leafletLoaded) {
      // yükleniyor — kısa bekle
      setTimeout(() => {
        if (window.L) resolve(window.L);
        else reject(new Error('Harita kütüphanesi yüklenemedi.'));
      }, 2000);
      return;
    }
    leafletLoaded = true;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => {
      leafletLoaded = false;
      reject(new Error('Harita kütüphanesi yüklenemedi (internet gerekli).'));
    };
    document.head.appendChild(js);
  });
}

const SEGMENT_COLORS = { pending: '#8a97a5', active: '#2b6cb0', completed: '#2f855a' };

function MapView({ poles, route, segments }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const [mapError, setMapError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then((L) => {
        if (cancelled || !divRef.current) return;
        if (mapRef.current) {
          mapRef.current.remove();
          mapRef.current = null;
        }
        const map = L.map(divRef.current, { scrollWheelZoom: true });
        mapRef.current = map;
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap',
          maxZoom: 19,
        }).addTo(map);

        const bounds = [];
        poles.forEach((p, i) => {
          const latlng = [p.lat, p.lon];
          bounds.push(latlng);
          L.marker(latlng, {
            icon: L.divIcon({
              className: 'pole-marker',
              html: `<span class="pole-pin">${i + 1}</span>`,
              iconSize: [24, 24],
              iconAnchor: [12, 12],
            }),
          })
            .addTo(map)
            .bindPopup(`<b>${p.name}</b><br/>${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`);
        });

        if (route && route.length >= 2) {
          bounds.push(...route);
          L.polyline(route, { color: '#f5a623', weight: 4, opacity: 0.85 }).addTo(map);
        }
        // Direkler arası bağlantı hattı (sıralı direkler üzerinden)
        if (poles.length >= 2) {
          bounds.push(...poles.map((p) => [p.lat, p.lon]));
          L.polyline(
            poles.map((p) => [p.lat, p.lon]),
            { color: '#0d1f3c', weight: 2.5, dashArray: '6 6', opacity: 0.75 }
          ).addTo(map);
        }
        // İş grubu kesimleri (durum rengiyle)
        if (segments && segments.length > 0) {
          for (const s of segments) {
            if (s.coords.length < 2) continue;
            bounds.push(...s.coords);
            L.polyline(s.coords, {
              color: SEGMENT_COLORS[s.status] || '#2b6cb0',
              weight: 5,
              opacity: 0.8,
            })
              .addTo(map)
              .bindTooltip(s.name, { sticky: true });
          }
        }
        if (bounds.length > 0) map.fitBounds(bounds, { padding: [30, 30] });
      })
      .catch((e) => {
        if (!cancelled) setMapError(e.message);
      });

    return () => {
      cancelled = true;
    };
  }, [poles, route]);

  if (mapError) {
    return (
      <div className="empty" style={{ border: '1px dashed var(--border)', borderRadius: 12, marginBottom: 16 }}>
        <span className="empty-ico">🗺️</span>
        {mapError} — koordinat tablosu aşağıda.
      </div>
    );
  }
  return <div ref={divRef} className="map-box" />;
}

export default function RouteMap({ embedded = false, projectId = null }) {
  const [data, setData] = useState(null);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);
  const [genMode, setGenMode] = useState(false);
  const [genFile, setGenFile] = useState(null);
  const [uploadMsg, setUploadMsg] = useState(null);
  const [genResult, setGenResult] = useState(null);

  async function load() {
    if (projectId == null) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const [poles, g] = await Promise.all([
        api.get(`/api/poles?project_id=${projectId}`),
        api.get(`/api/workgroups?project_id=${projectId}`),
      ]);
      setData(poles);
      setGroups(g);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setUploadMsg(null);
    const fd = new FormData();
    fd.append('project_id', projectId);
    fd.append('file', file);
    try {
      const res = await fetch('/api/poles/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: fd,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Yükleme başarısız.');
      setUploadMsg({
        type: 'ok',
        text:
          `${d.saved} direk kaydedildi` +
          (d.connection_km != null ? ` · hat uzunluğu ${d.connection_km} km` : '') +
          (d.route_points ? ` · güzergah hattı ${d.route_points} nokta (${d.route_km} km)` : ''),
      });
      setFile(null);
      await load();
    } catch (e) {
      setUploadMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  // Excel/PDF → otomatik KMZ üret + projeye aktar
  async function uploadGen() {
    if (!genFile) return;
    setBusy(true);
    setUploadMsg(null);
    setGenResult(null);
    const fd = new FormData();
    fd.append('project_id', projectId);
    fd.append('file', genFile);
    try {
      const res = await fetch('/api/kmz-generator/parse', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: fd,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Dönüştürme başarısız.');
      setGenResult(d);
      setUploadMsg({
        type: 'ok',
        text:
          `${d.count} direk bulundu, KMZ üretildi` +
          (d.connection_km != null ? ` · hat ${d.connection_km} km` : '') +
          (d.saved > 0 ? ` · projeye aktarıldı (${d.saved})` : ''),
      });
      setGenFile(null);
      await load();
    } catch (e) {
      setUploadMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (!window.confirm('Bu projenin tüm direkleri ve güzergahı silinecek. Emin misiniz?')) return;
    try {
      await api.del(`/api/poles?project_id=${projectId}`);
      await load();
    } catch (e) {
      alert('Silme başarısız: ' + e.message);
    }
  }

  function exportCsv() {
    if (!data?.poles?.length) return;
    const rows = [['Sıra', 'Ad', 'Enlem', 'Boylam', 'Rakım (m)']];
    data.poles.forEach((p, i) => rows.push([i + 1, p.name, p.lat, p.lon, p.alt ?? '']));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'direkler.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const poles = data?.poles || [];

  // İş gruplarının direk kesimlerini harita için hazırla
  const segments = useMemo(() => {
    if (!groups.length || poles.length === 0) return [];
    return groups
      .filter((g) => g.segment_from != null && g.segment_to != null)
      .map((g) => ({
        id: g.id,
        name: g.name,
        status: g.status,
        coords: poles.slice(g.segment_from - 1, g.segment_to).map((p) => [p.lat, p.lon]),
      }))
      .filter((s) => s.coords.length >= 2);
  }, [groups, poles]);

  return (
    <div>
      {!embedded && (
        <div className="page-head">
          <div>
            <h1>🗺️ Güzergah &amp; Direkler</h1>
            <p className="sub">KMZ dosyasından direk koordinatlarını içe aktarın</p>
          </div>
          {poles.length > 0 && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={() => apiDownload('/api/kmz-generator/from-project?project_id=' + projectId, 'guzergah.kmz')}>⬇️ KMZ İndir</button>
              <button className="btn" onClick={() => apiDownload('/api/export/poles?project_id=' + projectId, 'ptyp-direkler.xlsx')}>⬇️ Excel İndir</button>
              <button className="btn" onClick={exportCsv}>⬇️ CSV İndir</button>
              <button className="btn btn-danger" onClick={clearAll}>🗑️ Temizle</button>
            </div>
          )}
        </div>
      )}
      {embedded && poles.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <button className="btn" onClick={() => apiDownload('/api/kmz-generator/from-project?project_id=' + projectId, 'guzergah.kmz')}>⬇️ KMZ İndir</button>
          <button className="btn" onClick={() => apiDownload('/api/export/poles?project_id=' + projectId, 'ptyp-direkler.xlsx')}>⬇️ Excel İndir</button>
          <button className="btn" onClick={exportCsv}>⬇️ CSV İndir</button>
          <button className="btn btn-danger" onClick={clearAll}>🗑️ Temizle</button>
        </div>
      )}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button
            className={genMode ? 'tab-chip' : 'tab-chip on'}
            onClick={() => { setGenMode(false); setUploadMsg(null); }}
          >
            🗺️ KMZ / KML Yükle
          </button>
          <button
            className={genMode ? 'tab-chip on' : 'tab-chip'}
            onClick={() => { setGenMode(true); setUploadMsg(null); setGenResult(null); }}
          >
            📄 Excel / PDF → KMZ Üret
          </button>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <label
            className="file-drop"
            style={{ flex: 1, minWidth: 240, display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', border: '1.5px dashed var(--border)', borderRadius: 10, cursor: 'pointer' }}
          >
            <input
              type="file"
              accept={genMode ? '.xlsx,.xls,.pdf,.tif,.tiff' : '.kmz,.kml'}
              onChange={(e) => {
                if (genMode) setGenFile(e.target.files?.[0] || null);
                else setFile(e.target.files?.[0] || null);
                setUploadMsg(null);
              }}
            />
            <span className="file-drop-ico">📄</span>
            <span className="file-drop-text" style={{ flex: 1, textAlign: 'left' }}>
              {genMode
                ? (genFile ? genFile.name : 'Excel, PDF veya TIFF seçin — koordinatlar otomatik algılanır…')
                : (file ? file.name : 'KMZ dosyası seçin (Google Earth)…')}
            </span>
          </label>
          {genMode ? (
            <button className="btn btn-accent" onClick={uploadGen} disabled={busy || !genFile}>
              {busy ? 'Dönüştürülüyor…' : '⚙️ KMZ Üret ve Aktar'}
            </button>
          ) : (
            <button className="btn btn-accent" onClick={upload} disabled={busy || !file}>
              {busy ? 'Analiz ediliyor…' : '⬆️ Yükle ve Analiz Et'}
            </button>
          )}
        </div>
        {uploadMsg && (
          <div className={uploadMsg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginTop: 10, marginBottom: 0 }}>
            {uploadMsg.text}
            {genResult && uploadMsg.type === 'ok' && (
              <button
                className="btn btn-sm"
                style={{ marginLeft: 10 }}
                onClick={() => apiDownload(genResult.kmz, (genResult.file_name || 'guzergah').replace(/\.(xlsx|xls|pdf)$/i, '') + '.kmz')}
              >
                ⬇️ KMZ'yi İndir
              </button>
            )}
          </div>
        )}
        {data?.file_name && (
          <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
            Son yükleme: <strong>{data.file_name}</strong> · {fmtDate(data.uploaded_at)} · {poles.length} direk
            {data.connection_km != null && <> · hat {data.connection_km} km</>}
            {data.route_km != null && data.route_km > 0 && <> · KMZ güzergahı {data.route_km} km</>}
            {data.point_total > poles.length && <> · (dosyada toplam {data.point_total} nokta)</>}
          </div>
        )}
        {poles.length > 0 && (
          <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
            <span style={{ display: 'inline-block', width: 26, height: 3, background: '#f5a623', verticalAlign: 'middle', marginRight: 6 }} />
            KMZ güzergahı&nbsp;&nbsp;
            <span style={{ display: 'inline-block', width: 26, height: 0, borderTop: '2px dashed #0d1f3c', verticalAlign: 'middle', marginRight: 6 }} />
            direkler arası bağlantı&nbsp;&nbsp;
            {segments.length > 0 && (
              <>
                <span style={{ display: 'inline-block', width: 26, height: 4, background: '#2b6cb0', verticalAlign: 'middle', marginRight: 6 }} />
                iş grubu kesimi
                <span className="muted"> (mavi: devam · yeşil: tamamlandı · gri: başlamadı)</span>
              </>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="error-banner">
          <span>Veriler yüklenemedi: {error}</span>
          <button className="btn btn-sm" onClick={load}>Tekrar Dene</button>
        </div>
      )}

      {loading ? (
        <div className="empty"><span className="empty-ico">⏳</span>Yükleniyor…</div>
      ) : poles.length === 0 ? (
        <div className="empty">
          <span className="empty-ico">🗺️</span>
          Henüz güzergah yüklenmemiş. Google Earth'ten dışa aktardığınız KMZ dosyasını yukarıdan yükleyin.
        </div>
      ) : (
        <>
          <MapView poles={poles} route={data.route} segments={segments} />
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Direk</th>
                  <th className="num">Enlem</th>
                  <th className="num">Boylam</th>
                </tr>
              </thead>
              <tbody>
                {poles.map((p, i) => (
                  <tr key={p.id}>
                    <td className="num muted">{i + 1}</td>
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td className="num">{p.lat.toFixed(6)}</td>
                    <td className="num">{p.lon.toFixed(6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
