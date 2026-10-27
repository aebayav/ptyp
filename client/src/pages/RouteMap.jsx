import { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiDownload, postParse } from '../api';
import { fmtDate, loadLeaflet, okumaBilgisi } from '../utils';

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
        // OSM ve CARTO yayın alan adlarına 403/api-key uyguluyor;
        // Esri World Street Map anahtarsız, her bölgede açık.
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Tiles © Esri — Source: Esri, HERE, Garmin, OpenStreetMap contributors',
          maxZoom: 19,
        }).addTo(map);

        const bounds = [];
        let towerSeq = 0;
        poles.forEach((p, i) => {
          const latlng = [p.lat, p.lon];
          bounds.push(latlng);
          const m = p.meta || {};
          const isPortal =
            /^portal/i.test(p.name || '') ||
            m.tower_type === 'PORTAL' ||
            m.function === 'PORTAL' ||
            m.style === 'portal';
          if (!isPortal) towerSeq += 1;
          const fn = (m.function || '').toUpperCase();
          const isDead = m.style === 'dead' || ['KD', 'KT', 'N', 'D'].includes(fn);
          const pinBg = isPortal ? '#2563eb' : isDead ? '#dc2626' : '#d97706';
          const pinLabel = isPortal ? 'P' : towerSeq;

          const details = [];
          if (m.tower_type && m.tower_type !== 'PORTAL') details.push(`<b>Direk Tipi:</b> ${m.tower_type}`);
          if (m.function && m.function !== 'PORTAL') details.push(`<b>Fonksiyon:</b> ${m.function}`);
          if (m.station_text) details.push(`<b>İstasyon:</b> ${m.station_text}`);
          if (m.easting != null) details.push(`<b>X(E):</b> ${Number(m.easting).toFixed(2)}`);
          if (m.northing != null) details.push(`<b>Y(N):</b> ${Number(m.northing).toFixed(2)}`);
          const cr = (m.crossing || '').trim();
          const rm = (m.remarks || '').trim();
          const gecis = cr && rm && !cr.toLowerCase().includes(rm.toLowerCase()) ? `${cr} (${rm})` : cr || rm || '';
          if (gecis) details.push(`<b>Geçiş:</b> ${gecis}`);
          details.push(`<span style="color:#666">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</span>`);

          L.marker(latlng, {
            icon: L.divIcon({
              className: 'pole-marker',
              html: `<span class="pole-pin" style="background:${pinBg};color:#fff">${pinLabel}</span>`,
              iconSize: [24, 24],
              iconAnchor: [12, 12],
            }),
          })
            .addTo(map)
            .bindPopup(`<b>${p.name}</b><br/>${details.join('<br/>')}`);
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
        <span className="empty-ico"></span>
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
  const [utmZone, setUtmZone] = useState('0'); // her zaman otomatik algıla (il tablosu + doğrulama)
  const [refFile, setRefFile] = useState(null);
  const [calibBusy, setCalibBusy] = useState(false);

  // Referans KMZ ile hizalama: yerel şantiye gridi ofsetini öğren ve uygula
  async function calibrate() {
    if (!refFile || projectId == null) return;
    setCalibBusy(true);
    const fd = new FormData();
    fd.append('project_id', projectId);
    fd.append('file', refFile);
    try {
      const d = await api.upload('/api/kmz-generator/calibrate', fd);
      setUploadMsg({
        type: 'ok',
        text: `Hizalama tamam: +${d.northM} m kuzey, +${d.eastM} m doğu — ${d.matched} eşleşme, ${d.applied} direk kaydırıldı. Yeni belge dönüşümlerinde bu ofset otomatik uygulanır.`,
      });
      setRefFile(null);
      await load();
    } catch (e) {
      setUploadMsg({ type: 'err', text: e.message });
    } finally {
      setCalibBusy(false);
    }
  }

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
      const d = await api.upload('/api/poles/upload', fd);
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

  // Excel/PDF otomatik KMZ üret + projeye aktar
  async function uploadGen() {
    if (!genFile) return;
    setBusy(true);
    setUploadMsg(null);
    setGenResult(null);
    const fd = new FormData();
    fd.append('project_id', projectId);
    fd.append('file', genFile);
    fd.append('tm3_cm', utmZone === '0' ? 0 : utmZone);
    try {
      const d = await postParse(fd);
      setGenResult(d);
      setUploadMsg({
        type: 'ok',
        text:
          `${d.count} direk bulundu, KMZ üretildi` +
          (d.tm3_cm_used ? ` · DOM ${d.tm3_cm_used}°` : '') +
          (d.connection_km != null ? ` · hat ${d.connection_km} km` : '') +
          (d.saved > 0 ? ` · projeye aktarıldı (${d.saved})` : ''),
      });
      console.log('[Güzergah]', okumaBilgisi(d));
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
    const rows = [['Sıra', 'Ad', 'Direk Tipi', 'Fonksiyon', 'İstasyon', 'X(E)', 'Y(N)', 'Geçiş / Açıklama', 'Enlem', 'Boylam', 'Rakım (m)']];
    data.poles.forEach((p, i) => {
      const m = p.meta || {};
      const cr = (m.crossing || '').trim();
      const rm = (m.remarks || '').trim();
      const gecis = cr && rm && !cr.toLowerCase().includes(rm.toLowerCase()) ? `${cr} (${rm})` : cr || rm || '';
      rows.push([
        i + 1,
        p.name,
        m.tower_type || '',
        m.function || '',
        m.station_text || '',
        m.easting != null ? Number(m.easting).toFixed(2) : '',
        m.northing != null ? Number(m.northing).toFixed(2) : '',
        gecis,
        p.lat,
        p.lon,
        p.alt ?? '',
      ]);
    });
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
            <h1>Güzergah &amp; Direkler</h1>
            <p className="sub">KMZ'den direk koordinatlarını içe aktarın</p>
          </div>
          {poles.length > 0 && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={() => apiDownload('/api/kmz-generator/from-project?project_id=' + projectId, (data?.file_name || 'guzergah').replace(/\.[^.]+$/, '') + '.kmz')}>KMZ İndir</button>
              <button className="btn" onClick={() => apiDownload('/api/export/poles?project_id=' + projectId, 'ptyp-direkler.xlsx')}>Excel İndir</button>
              <button className="btn" onClick={exportCsv}>CSV İndir</button>
              <button className="btn btn-danger" onClick={clearAll}>Temizle</button>
            </div>
          )}
        </div>
      )}
      {embedded && poles.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <button className="btn" onClick={() => apiDownload('/api/kmz-generator/from-project?project_id=' + projectId, 'guzergah.kmz')}>KMZ İndir</button>
          <button className="btn" onClick={() => apiDownload('/api/export/poles?project_id=' + projectId, 'ptyp-direkler.xlsx')}>Excel İndir</button>
          <button className="btn" onClick={exportCsv}>CSV İndir</button>
          <button className="btn btn-danger" onClick={clearAll}>Temizle</button>
        </div>
      )}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            className={genMode ? 'tab-chip' : 'tab-chip on'}
            onClick={() => { setGenMode(false); setUploadMsg(null); }}
          >
            KMZ / KML Yükle
          </button>
          <button
            className={genMode ? 'tab-chip on' : 'tab-chip'}
            onClick={() => { setGenMode(true); setUploadMsg(null); setGenResult(null); }}
          >
            Excel / PDF → KMZ Üret
          </button>
          <span style={{ flex: 1 }} />
          <label
            className="file-drop"
            title="Orijinal güzergah KMZ'sini yükleyip yerel grid ofsetini otomatik hesaplar"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', border: '1.5px dashed var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: 12.5 }}
          >
            <input
              type="file"
              accept=".kmz,.kml"
              onChange={(e) => { setRefFile(e.target.files?.[0] || null); setUploadMsg(null); }}
            />
            {refFile ? refFile.name : 'Referans KMZ (hizalama)'}
          </label>
          <button className="btn btn-sm" onClick={calibrate} disabled={calibBusy || !refFile || projectId == null}>
            {calibBusy ? 'Hizalanıyor…' : 'Hizala'}
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
            <span className="file-drop-ico"></span>
            <span className="file-drop-text" style={{ flex: 1, textAlign: 'left' }}>
              {genMode
                ? (genFile ? genFile.name : 'Excel, PDF veya TIFF seçin — koordinatlar otomatik algılanır…')
                : (file ? file.name : 'KMZ dosyası seçin (Google Earth)…')}
            </span>
          </label>
          {genMode ? (
            <>
              <select value={utmZone} onChange={(e) => setUtmZone(e.target.value)} title="ITRF-96 3° Dilim Orta Meridyeni">
                <option value="0">DOM: Otomatik (İl Tablosu)</option>
                <option value="27">DOM 27° (Ege / Trakya)</option>
                <option value="30">DOM 30° (Marmara / Batı İç Anadolu)</option>
                <option value="33">DOM 33° (İç Anadolu / Batı Karadeniz)</option>
                <option value="36">DOM 36° (Çukurova / Orta Anadolu / Orta Karadeniz)</option>
                <option value="39">DOM 39° (Güneydoğu / Doğu Karadeniz)</option>
                <option value="42">DOM 42° (Doğu Anadolu)</option>
                <option value="45">DOM 45° (Hakkari / Iğdır)</option>
              </select>
              <button className="btn btn-accent" onClick={uploadGen} disabled={busy || !genFile}>
                {busy ? 'Dönüştürülüyor…' : 'KMZ Üret ve Aktar'}
              </button>
            </>
          ) : (
            <button className="btn btn-accent" onClick={upload} disabled={busy || !file}>
              {busy ? 'Analiz ediliyor…' : 'Yükle ve Analiz Et'}
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
                KMZ'yi İndir
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
        <div className="empty"><span className="empty-ico"></span>Yükleniyor…</div>
      ) : poles.length === 0 ? (
        <div className="empty">
          <span className="empty-ico"></span>
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
                  <th>Tip</th>
                  <th>Fonksiyon</th>
                  <th>İstasyon</th>
                  <th className="num">X(E) / Y(N)</th>
                  <th>Geçiş / Açıklama</th>
                  <th className="num">Enlem</th>
                  <th className="num">Boylam</th>
                </tr>
              </thead>
              <tbody>
                {poles.map((p, i) => {
                  const m = p.meta || {};
                  const cr = (m.crossing || '').trim();
                  const rm = (m.remarks || '').trim();
                  const gecis =
                    cr && rm && !cr.toLowerCase().includes(rm.toLowerCase()) ? `${cr} (${rm})` : cr || rm || '';
                  return (
                    <tr key={p.id}>
                      <td className="num muted">{i + 1}</td>
                      <td style={{ fontWeight: 600 }}>{p.name}</td>
                      <td>{m.tower_type || '—'}</td>
                      <td>{m.function || '—'}</td>
                      <td>{m.station_text || '—'}</td>
                      <td className="num muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {m.easting != null && m.northing != null
                          ? `${Number(m.easting).toFixed(2)} / ${Number(m.northing).toFixed(2)}`
                          : '—'}
                      </td>
                      <td>{gecis || '—'}</td>
                      <td className="num">{p.lat.toFixed(6)}</td>
                      <td className="num">{p.lon.toFixed(6)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
