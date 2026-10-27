import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, getToken } from '../api';
import { useAuth } from '../AuthContext';
import Modal from '../components/Modal';
import { loadLeaflet, useProjects } from '../utils';
import {
  STAGE_CHECKLISTS,
  cacheProjectSahaData,
  enqueueOfflineSubmission,
  findNearestPole,
  getCachedProjectSahaData,
  listOfflineSubmissions,
  processFieldPhotoClient,
  removeOfflineSubmission,
} from '../saha-mobile-utils';

// Oturumlu fotoğraf: token ile fetch → blob URL (img etiketi Authorization gönderemez)
function PhotoImg({ url, className = 'photo-thumb', onClick }) {
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
  if (!src) return <span className={`${className} photo-loading`}>…</span>;
  return <img src={src} className={className} alt="" onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined} />;
}

const DECISION_BADGE = {
  auto_approved: { label: '🟢 Otomatik Onay', cls: 'badge-green', color: '#16a34a' },
  manual_approved: { label: '🟢 Teknik Ofis Onaylı', cls: 'badge-green', color: '#15803d' },
  needs_review: { label: '🟡 İnceleme Bekliyor', cls: 'badge-amber', color: '#d97706' },
  rejected: { label: '🔴 Reddedildi', cls: 'badge-red', color: '#dc2626' },
  manual_rejected: { label: '🔴 Teknik Ofis Reddi', cls: 'badge-red', color: '#b91c1c' },
};

export default function Saha() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isOwner = user?.role === 'owner';
  const [params] = useSearchParams();
  const pathParams = useParams(); // /saha/direk/:proje/:direk
  const qProje = params.get('proje') ?? pathParams.proje;
  const focusIdx = params.get('direk') ?? pathParams.direk;
  const { projects, projectId, setProjectId } = useProjects(qProje);

  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [filter, setFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [flashIdx, setFlashIdx] = useState(null);
  const [tab, setTab] = useState('poles'); // poles | pool | requests

  // Mobil GPS & En Yakın Direk durumu (açık koordinat dışarı gönderilmez, cihazda tutulur)
  const [gpsState, setGpsState] = useState({
    loading: false,
    lat: null,
    lon: null,
    accuracy: null,
    error: null,
    updatedAt: null,
  });

  // Çevrimdışı kuyruk (IndexedDB)
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
  const [offlineQueue, setOfflineQueue] = useState([]);
  const [syncingOffline, setSyncingOffline] = useState(false);

  // Kanıtlı Fotoğraf & Aşama Gönderim Modalı
  const [capturePole, setCapturePole] = useState(null);
  const [captureStage, setCaptureStage] = useState('foundation');
  const [captureNote, setCaptureNote] = useState('');
  const [captureChecklist, setCaptureChecklist] = useState([]);
  const [processedPhotos, setProcessedPhotos] = useState([]);
  const [processingPhoto, setProcessingPhoto] = useState(false);
  const [submittingCapture, setSubmittingCapture] = useState(false);
  const [lastDecisionResult, setLastDecisionResult] = useState(null);
  const [listeningVoice, setListeningVoice] = useState(false);

  // Fotoğraf & Kanıt Karnesi İnceleme Modalı
  const [inspectPhoto, setInspectPhoto] = useState(null); // { photo, pole }
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewNoteInput, setReviewNoteInput] = useState('');

  // Hakediş Havuzu (hakedis_pool)
  const [poolData, setPoolData] = useState({ items: [], summary: null });
  const [poolFilter, setPoolFilter] = useState('all');
  const [poolBusy, setPoolBusy] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);

  // Malzeme Talepleri
  const [requests, setRequests] = useState([]);
  const [reqForm, setReqForm] = useState({ item_name: '', qty: '1', unit: 'adet', pole_ref: '', needed_by: '', note: '' });

  const mapDivRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const layerRef = useRef(null);
  const cameraInputRef = useRef(null);

  // Çevrimdışı / çevrimiçi dinleyicisi
  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  async function refreshOfflineQueue() {
    if (projectId == null) return;
    const list = await listOfflineSubmissions(projectId);
    setOfflineQueue(list);
  }

  async function load() {
    if (projectId == null) return;
    setBusy(true);
    setMsg(null);
    try {
      const d = await api.get(`/api/saha/${projectId}`);
      setData(d);
      await cacheProjectSahaData(projectId, d);
      if (focusIdx != null) setFilter('all');
    } catch (e) {
      // Şebeke yoksa IndexedDB önbelleğinden yükle
      const cached = await getCachedProjectSahaData(projectId);
      if (cached?.data) {
        setData(cached.data);
        setMsg({
          type: 'ok',
          text: `⚡ Çevrimdışı mod: Proje verileri cihaz önbelleğinden yüklendi (${new Date(cached.cachedAt).toLocaleTimeString('tr-TR')}).`,
        });
      } else {
        setData(null);
        setMsg({ type: 'err', text: e.message });
      }
    } finally {
      setBusy(false);
      refreshOfflineQueue();
    }
  }

  async function loadPool() {
    if (projectId == null) return;
    setPoolBusy(true);
    try {
      const d = await api.get(`/api/saha/${projectId}/hakedis-pool`);
      setPoolData(d);
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setPoolBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (tab === 'pool') loadPool();
    if (tab === 'requests') loadRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, projectId]);

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

  // Harita: tile + güzergah çizgisi + durum renkli direkler
  useEffect(() => {
    if (!data || !mapDivRef.current || tab !== 'poles') return;
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
  }, [data, filter, tab]);

  // Cihaz GPS konumunu al (En Yakın Direk bulucu için)
  function locateNearestPole(autoOpenModal = false) {
    if (!navigator.geolocation) {
      setGpsState((s) => ({ ...s, error: 'Cihazınızda konum servisi desteklenmiyor.' }));
      return;
    }
    setGpsState((s) => ({ ...s, loading: true, error: null }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        setGpsState({
          loading: false,
          lat: latitude,
          lon: longitude,
          accuracy: Math.round(accuracy || 0),
          error: null,
          updatedAt: new Date(),
        });
        if (data?.poles?.length) {
          const match = findNearestPole(latitude, longitude, data.poles);
          if (match?.nearestPole) {
            const np = match.nearestPole;
            const el = document.getElementById(`pole-row-${np.idx}`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setFlashIdx(np.idx);
            setTimeout(() => setFlashIdx(null), 2600);
            if (autoOpenModal) {
              openCaptureModal(np, latitude, longitude);
            }
          }
        }
      },
      (err) => {
        setGpsState((s) => ({
          ...s,
          loading: false,
          error: 'Konum alınamadı: ' + (err.message || 'İzin verilmedi'),
        }));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
    );
  }

  const nearestMatch =
    gpsState.lat != null && gpsState.lon != null && data?.poles?.length
      ? findNearestPole(gpsState.lat, gpsState.lon, data.poles, capturePole?.idx)
      : null;

  function openCaptureModal(pole, overrideLat = null, overrideLon = null) {
    // Varsayılan olarak bir sonraki mantıklı aşamayı öner
    const order = ['excavation', 'foundation', 'erection', 'fittings', 'stringing', 'completed'];
    const curIdx = order.indexOf(pole.status);
    const nextStage = curIdx >= 0 && curIdx < order.length - 1 ? order[curIdx + 1] : pole.status === 'none' ? 'excavation' : pole.status;

    setCapturePole(pole);
    setCaptureStage(nextStage);
    setCaptureNote(pole.note || '');
    setCaptureChecklist([]);
    setProcessedPhotos([]);
    setLastDecisionResult(null);

    // Eğer henüz GPS alınmadıysa sessizce arka planda konum iste
    if (overrideLat == null && gpsState.lat == null && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setGpsState({
            loading: false,
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy || 0),
            error: null,
            updatedAt: new Date(),
          });
        },
        () => {},
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 20000 }
      );
    }
  }

  async function handleCameraFilesSelected(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length || !capturePole) return;
    setProcessingPhoto(true);
    try {
      const distM =
        gpsState.lat != null && gpsState.lon != null
          ? findNearestPole(gpsState.lat, gpsState.lon, data?.poles || [], capturePole.idx)?.selectedDistanceM
          : null;
      const stageLabel = data?.statuses?.[captureStage]?.label || captureStage;
      const out = [];
      for (const f of files.slice(0, 4)) {
        const proc = await processFieldPhotoClient(f, {
          projectName: data?.project_name || 'PTYP',
          poleName: capturePole.name,
          towerType: capturePole.tower_type || '',
          stageLabel,
          distanceM: distM,
        });
        out.push(proc);
      }
      setProcessedPhotos((prev) => [...prev, ...out].slice(0, 6));
    } catch (err) {
      setMsg({ type: 'err', text: 'Fotoğraf işlenemedi: ' + (err.message || 'hata') });
    } finally {
      setProcessingPhoto(false);
      if (cameraInputRef.current) cameraInputRef.current.value = '';
    }
  }

  function startVoiceNote() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      alert('Tarayıcınız sesli not (Web Speech API) özelliğini desteklemiyor.');
      return;
    }
    const rec = new SpeechRec();
    rec.lang = 'tr-TR';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    setListeningVoice(true);
    rec.onresult = (ev) => {
      const txt = ev.results?.[0]?.[0]?.transcript || '';
      if (txt) {
        setCaptureNote((prev) => (prev ? `${prev} ${txt}` : txt));
      }
    };
    rec.onerror = () => setListeningVoice(false);
    rec.onend = () => setListeningVoice(false);
    rec.start();
  }

  async function submitGuidedCapture(e) {
    e.preventDefault();
    if (!capturePole || processedPhotos.length === 0) return;
    setSubmittingCapture(true);
    setLastDecisionResult(null);

    const distM =
      gpsState.lat != null && gpsState.lon != null
        ? findNearestPole(gpsState.lat, gpsState.lon, data?.poles || [], capturePole.idx)?.selectedDistanceM
        : null;

    const fd = new FormData();
    fd.append('pole_idx', String(capturePole.idx));
    fd.append('stage', captureStage);
    fd.append('note', captureNote);
    fd.append('caption', `${capturePole.name} — ${data?.statuses?.[captureStage]?.label || captureStage}`);
    fd.append('checklist', JSON.stringify(captureChecklist));
    if (gpsState.lat != null && gpsState.lon != null) {
      fd.append('capture_lat', String(gpsState.lat));
      fd.append('capture_lon', String(gpsState.lon));
    }
    if (distM != null) {
      fd.append('gps_distance_m', String(distM));
    }
    for (const p of processedPhotos) {
      fd.append('photos', p.file);
    }

    try {
      if (!navigator.onLine) {
        throw new Error('OFFLINE_MODE');
      }
      const res = await api.upload(`/api/saha/${projectId}/photos`, fd);
      setLastDecisionResult(res);
      await load();
      if (tab === 'pool') await loadPool();
    } catch (err) {
      // Şebeke hatası veya çevrimdışı durumdaysa IndexedDB kuyruğuna kaydet
      if (!navigator.onLine || err.message === 'OFFLINE_MODE' || /fetch|network|failed/i.test(err.message || '')) {
        await enqueueOfflineSubmission({
          projectId,
          poleIdx: capturePole.idx,
          poleName: capturePole.name,
          stage: captureStage,
          stageLabel: data?.statuses?.[captureStage]?.label || captureStage,
          note: captureNote,
          checklist: captureChecklist,
          captureLat: gpsState.lat,
          captureLon: gpsState.lon,
          gpsDistanceM: distM,
          files: processedPhotos.map((p) => p.file),
        });
        await refreshOfflineQueue();
        setCapturePole(null);
        setMsg({
          type: 'ok',
          text: `⚡ Şebeke yok: ${capturePole.name} kanıtlı fotoğrafı Çevrimdışı Kuyruğa kaydedildi. İnternet geldiğinde tek tuşla gönderilecek.`,
        });
      } else {
        setMsg({ type: 'err', text: 'Gönderim başarısız: ' + (err.message || 'hata') });
      }
    } finally {
      setSubmittingCapture(false);
    }
  }

  async function syncOfflineQueueNow() {
    if (offlineQueue.length === 0 || syncingOffline) return;
    setSyncingOffline(true);
    let okCount = 0;
    try {
      for (const item of offlineQueue) {
        const fd = new FormData();
        fd.append('pole_idx', String(item.poleIdx));
        fd.append('stage', item.stage || '');
        fd.append('note', item.note || '');
        fd.append('caption', `${item.poleName} — ${item.stageLabel || ''}`);
        fd.append('checklist', JSON.stringify(item.checklist || []));
        if (item.captureLat != null && item.captureLon != null) {
          fd.append('capture_lat', String(item.captureLat));
          fd.append('capture_lon', String(item.captureLon));
        }
        if (item.gpsDistanceM != null) {
          fd.append('gps_distance_m', String(item.gpsDistanceM));
        }
        for (const f of item.files || []) {
          fd.append('photos', f);
        }
        await api.upload(`/api/saha/${item.projectId}/photos`, fd);
        await removeOfflineSubmission(item.id);
        okCount++;
      }
      await refreshOfflineQueue();
      await load();
      setMsg({ type: 'ok', text: `✓ Çevrimdışı kuyruktaki ${okCount} kayıt başarıyla doğrulandı ve hakediş havuzuna aktarıldı.` });
    } catch (e) {
      setMsg({ type: 'err', text: `Senkronizasyon sırasında hata (${okCount} tamamlandı): ${e.message}` });
    } finally {
      setSyncingOffline(false);
    }
  }

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
    return data?.poles.find((p) => p.idx === idx)?.name || `D-${idx}`;
  }

  async function deletePhoto(photoId) {
    if (!window.confirm('Fotoğraf silinsin mi?')) return;
    try {
      await api.del(`/api/saha/photos/${photoId}`);
      if (inspectPhoto?.photo?.id === photoId) setInspectPhoto(null);
      await load();
      if (tab === 'pool') await loadPool();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  async function handleReviewPhoto(photoId, action) {
    setReviewBusy(true);
    try {
      await api.put(`/api/saha/photos/${photoId}/review`, {
        action,
        review_note: reviewNoteInput,
      });
      setInspectPhoto(null);
      setReviewNoteInput('');
      await load();
      if (tab === 'pool') await loadPool();
      setMsg({
        type: 'ok',
        text: action === 'approve' ? 'Fotoğraf onaylandı ve Hakediş Havuzuna eklendi.' : 'Fotoğraf reddedildi.',
      });
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setReviewBusy(false);
    }
  }

  async function handlePoolStatusChange(poolId, newStatus) {
    try {
      await api.put(`/api/saha/hakedis-pool/${poolId}`, { status: newStatus });
      await loadPool();
      await load();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  async function handleTransferPoolToHakedis() {
    if (!window.confirm('Hakediş havuzundaki tüm ONAYLI (Hazır) direk imalatları Hakediş Yönetimi dönemine aktarılacak. Onaylıyor musunuz?')) {
      return;
    }
    setTransferBusy(true);
    try {
      const res = await api.post(`/api/saha/${projectId}/hakedis-pool/transfer`, {});
      await loadPool();
      await load();
      setMsg({
        type: 'ok',
        text: `✓ ${res.transferred_count} adet doğrulanmış direk imalatı "${res.payment?.period_label}" dönemine aktarıldı.`,
      });
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setTransferBusy(false);
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
  const poolCounts = data?.pool_summary || { ready: 0, pending_review: 0, transferred: 0, rejected: 0 };
  const openCount = requests.filter((r) => r.status === 'open').length;

  const filteredPoles = (data?.poles || []).filter((p) => {
    if (filter !== 'all' && p.status !== filter) return false;
    if (searchTerm.trim()) {
      const q = searchTerm.trim().toLowerCase();
      return (
        String(p.name || '').toLowerCase().includes(q) ||
        String(p.tower_type || '').toLowerCase().includes(q) ||
        String(p.station_text || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const checklistConfig = STAGE_CHECKLISTS[captureStage] || STAGE_CHECKLISTS.foundation;

  return (
    <div>
      <div className="page-head" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>Saha &amp; Mobil Doğrulama</h1>
            <span
              className={`badge ${isOnline ? 'badge-green' : 'badge-amber'}`}
              style={{ fontSize: 11 }}
              title="Lokal Doğrulama & Çevrimdışı Senkronizasyon Durumu"
            >
              {isOnline ? '● Çevrimiçi (Lokal Karar Motoru Aktif)' : '⚡ Çevrimdışı Mod (Kuyruğa Kaydedilir)'}
            </span>
          </div>
          <p className="sub">
            Direk bazlı saha ilerlemesi, koordinat gizlilik korumalı kanıt fotoğrafı ve otomatik hakediş havuzu
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            onClick={() => locateNearestPole(false)}
            disabled={projectId == null || gpsState.loading}
          >
            {gpsState.loading ? '📍 Konum Alınıyor…' : '📍 Yanımdaki Direği Bul'}
          </button>
          <button className="btn" onClick={openQr} disabled={projectId == null} title="Direk QR kartlarını yazdırmak için">
            QR Çıktısı
          </button>
        </div>
      </div>

      {/* Mobil GPS Radar Kartı — En Yakın Direk Kilidi */}
      {(nearestMatch?.nearestPole || gpsState.error) && (
        <div
          className="card"
          style={{
            marginBottom: 14,
            padding: '12px 16px',
            borderLeft: nearestMatch?.nearestDistanceM <= 60 ? '4px solid #16a34a' : '4px solid #f5a623',
            background: 'var(--bg-soft, #f8fafc)',
          }}
        >
          {gpsState.error ? (
            <div style={{ color: '#dc2626', fontSize: 13 }}>{gpsState.error}</div>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
                  📍 Cihaz İçi GPS En Yakın Direk Tespiti (Açık Koordinat Kaydedilmez)
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>
                  {nearestMatch.nearestPole.name}{' '}
                  <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>
                    ({nearestMatch.nearestPole.tower_type || 'Standart'}
                    {nearestMatch.nearestPole.pole_function ? ` · ${nearestMatch.nearestPole.pole_function}` : ''})
                  </span>
                  {' — '}
                  <span style={{ color: nearestMatch.nearestDistanceM <= 55 ? '#16a34a' : '#d97706' }}>
                    Δ {nearestMatch.nearestDistanceM} metre
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    const el = document.getElementById(`pole-row-${nearestMatch.nearestPole.idx}`);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    setFlashIdx(nearestMatch.nearestPole.idx);
                  }}
                >
                  Listede Göster
                </button>
                <button
                  className="btn btn-sm btn-accent"
                  onClick={() => openCaptureModal(nearestMatch.nearestPole)}
                >
                  📸 {nearestMatch.nearestPole.name} İçin Kanıt Çek
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Çevrimdışı Senkronizasyon Kuyruğu Uyarısı */}
      {offlineQueue.length > 0 && (
        <div
          className="notice-banner"
          style={{
            marginBottom: 14,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          <div>
            <b>⚡ Çevrimdışı Kuyrukta {offlineQueue.length} Bekleyen Saha Kanıtı Var</b>
            <div style={{ fontSize: 12, opacity: 0.9 }}>
              Şebeke yokken çekilen fotoğraflar cihazınızda güvenle saklandı.
            </div>
          </div>
          <button
            className="btn btn-sm btn-primary"
            onClick={syncOfflineQueueNow}
            disabled={!isOnline || syncingOffline}
          >
            {syncingOffline ? 'Gönderiliyor…' : '🔄 Şimdi Sunucuya Gönder'}
          </button>
        </div>
      )}

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
              SAHA İLERLEME:
            </span>
            <div className="progress-track mini" style={{ width: 150 }}>
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
              🗼 Direkler ({data.poles.length})
            </button>
            <button className={`tab-chip ${tab === 'pool' ? 'on' : ''}`} onClick={() => setTab('pool')}>
              🛡️ Doğrulama &amp; Hakediş Havuzu
              {poolCounts.ready + poolCounts.pending_review > 0
                ? ` (${poolCounts.ready} Hazır${poolCounts.pending_review > 0 ? ` · ${poolCounts.pending_review} İnceleme` : ''})`
                : ''}
            </button>
            <button className={`tab-chip ${tab === 'requests' ? 'on' : ''}`} onClick={() => setTab('requests')}>
              📦 Malzeme Talepleri{openCount > 0 ? ` (${openCount})` : ''}
            </button>
          </div>

          {tab === 'poles' && (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
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
                <input
                  type="search"
                  placeholder="Direk ara (örn: D-47, PE1)…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  style={{ marginLeft: 'auto', minWidth: 190, padding: '5px 10px', fontSize: 12.5 }}
                />
              </div>

              <div className="card" style={{ marginBottom: 14, padding: 10 }}>
                <div ref={mapDivRef} className="saha-map" />
              </div>

              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                  <h3 style={{ margin: 0 }}>Direk Listesi &amp; Kanıtlı İlerleme</h3>
                  <span className="muted" style={{ fontSize: 12 }}>
                    🔒 Fotoğraflardan GPS EXIF verisi otomatik temizlenir; yalnızca direğe bağıl sapma (Δm) doğrulanır.
                  </span>
                </div>

                {filteredPoles.map((p) => {
                  const st = statuses[p.status] || statuses.none;
                  return (
                    <div key={p.idx} id={`pole-row-${p.idx}`} className={`pole-row ${flashIdx === p.idx ? 'flash' : ''}`}>
                      <div className="pole-info">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <b>{p.name}</b>
                          {p.tower_type && (
                            <span className="badge badge-gray" style={{ fontSize: 10.5 }}>
                              {p.tower_type}
                              {p.pole_function ? ` · ${p.pole_function}` : ''}
                            </span>
                          )}
                        </div>
                        <span className="muted">
                          {p.station_text ? `İst: ${p.station_text}` : ''}
                          {p.span_m ? ` · Ara: ${p.span_m}m` : ''}
                        </span>
                        {p.updated_by && (
                          <span className="muted" style={{ fontSize: 10.5 }}>
                            Son: {p.updated_by}
                          </span>
                        )}
                      </div>

                      <div className="pole-actions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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
                          className="btn btn-sm btn-primary"
                          onClick={() => openCaptureModal(p)}
                          title="Kamera ile doğrulanmış aşama fotoğrafı çek ve hakediş havuzuna gönder"
                        >
                          📸 Kanıt Çek ({p.photos.length})
                        </button>
                      </div>

                      <div className="pole-note">
                        <input
                          value={p.note}
                          placeholder="Saha notu ekle…"
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
                        <div className="pole-photos" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                          {p.photos.map((ph) => {
                            const dbadge = DECISION_BADGE[ph.decision_status] || DECISION_BADGE.auto_approved;
                            return (
                              <span
                                key={ph.id}
                                className="photo-wrap"
                                style={{
                                  position: 'relative',
                                  border: `2px solid ${dbadge.color}`,
                                  borderRadius: 6,
                                  overflow: 'hidden',
                                }}
                                title={`${ph.caption || 'Fotoğraf'} · Skor: ${ph.decision_score}/100${ph.gps_distance_m != null ? ` · Δ ${ph.gps_distance_m}m` : ''}`}
                              >
                                <PhotoImg
                                  url={ph.url}
                                  onClick={() => {
                                    setInspectPhoto({ photo: ph, pole: p });
                                    setReviewNoteInput(ph.review_note || '');
                                  }}
                                />
                                <span
                                  onClick={() => {
                                    setInspectPhoto({ photo: ph, pole: p });
                                    setReviewNoteInput(ph.review_note || '');
                                  }}
                                  style={{
                                    position: 'absolute',
                                    bottom: 0,
                                    left: 0,
                                    right: 0,
                                    background: 'rgba(13,31,60,0.85)',
                                    color: '#fff',
                                    fontSize: 9.5,
                                    fontWeight: 700,
                                    textAlign: 'center',
                                    padding: '1px 3px',
                                    cursor: 'pointer',
                                  }}
                                >
                                  {ph.decision_score}p{ph.gps_distance_m != null ? ` · ${Math.round(ph.gps_distance_m)}m` : ''}
                                </span>
                                <button
                                  className="photo-del"
                                  title="Sil"
                                  onClick={() => deletePhoto(ph.id)}
                                >
                                  ✕
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {filteredPoles.length === 0 && (
                  <div className="empty">
                    Gösterilecek direk bulunamadı.
                  </div>
                )}
              </div>
            </>
          )}

          {/* TAB 2: DOĞRULAMA & OTOMATİK HAKEDİŞ HAVUZU */}
          {tab === 'pool' && (
            <>
              {poolData.summary && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: 12,
                    marginBottom: 14,
                  }}
                >
                  <div className="card" style={{ padding: '12px 16px', borderLeft: '4px solid #16a34a' }}>
                    <div className="muted" style={{ fontSize: 11.5, fontWeight: 700 }}>🟢 HAKEDİŞE HAZIR (ONAYLI)</div>
                    <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{poolData.summary.ready_count} İmalat</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      Karar motorundan geçti, aktarıma hazır
                    </div>
                  </div>
                  <div className="card" style={{ padding: '12px 16px', borderLeft: '4px solid #d97706' }}>
                    <div className="muted" style={{ fontSize: 11.5, fontWeight: 700 }}>🟡 TEKNİK OFİS İNCELEMESİ</div>
                    <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{poolData.summary.pending_review_count} Kayıt</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      Sınırda kalan / tek tık onay bekleyen
                    </div>
                  </div>
                  <div className="card" style={{ padding: '12px 16px', borderLeft: '4px solid #2563eb' }}>
                    <div className="muted" style={{ fontSize: 11.5, fontWeight: 700 }}>🏗️ HAZIR DTL METRAJI</div>
                    <div style={{ fontSize: 16, fontWeight: 800, marginTop: 6 }}>
                      {poolData.summary.ready_steel_kg.toLocaleString('tr-TR')} kg Çelik
                    </div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      Beton: {poolData.summary.ready_concrete_m3} m³ · Kazı: {poolData.summary.ready_excavation_m3} m³
                    </div>
                  </div>
                  <div className="card" style={{ padding: '12px 16px', borderLeft: '4px solid #64748b' }}>
                    <div className="muted" style={{ fontSize: 11.5, fontWeight: 700 }}>📄 HAKEDİŞE AKTARILAN</div>
                    <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{poolData.summary.transferred_count} Kalem</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      Reddedilen: {poolData.summary.rejected_count}
                    </div>
                  </div>
                </div>
              )}

              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                  <div>
                    <h3 style={{ margin: 0 }}>Lokal Karar Motoru &amp; Canlı Hakediş Havuzu</h3>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      Doğrulanan her direk aşaması DTL tablosundaki tip ve tonajıyla otomatik metraj satırına dönüşür.
                    </div>
                  </div>
                  {isOwner && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        className="btn"
                        onClick={() => navigate('/hakedisler')}
                      >
                        Hakediş Yönetimine Git →
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={!poolData.summary?.ready_count || transferBusy}
                        onClick={handleTransferPoolToHakedis}
                      >
                        {transferBusy
                          ? 'Aktarılıyor…'
                          : `📄 Onaylı Havuzu Hakedişe Aktar (${poolData.summary?.ready_count || 0})`}
                      </button>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                  {[
                    { key: 'all', label: `Tümü (${poolData.items.length})` },
                    { key: 'pending_review', label: `🟡 İnceleme Bekleyen (${poolData.summary?.pending_review_count || 0})` },
                    { key: 'ready', label: `🟢 Hakedişe Hazır (${poolData.summary?.ready_count || 0})` },
                    { key: 'transferred', label: `📄 Aktarılan (${poolData.summary?.transferred_count || 0})` },
                    { key: 'rejected', label: `🔴 Reddedilen (${poolData.summary?.rejected_count || 0})` },
                  ].map((f) => (
                    <button
                      key={f.key}
                      className={`tab-chip ${poolFilter === f.key ? 'on' : ''}`}
                      onClick={() => setPoolFilter(f.key)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {poolBusy ? (
                  <div className="empty">Yükleniyor…</div>
                ) : poolData.items.length === 0 ? (
                  <div className="empty">
                    Henüz hakediş havuzunda kayıt yok. Direk listesinden <b>📸 Kanıt Çek</b> ile fotoğraf yüklediğinizde karar motoru otomatik olarak burayı doldurur.
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Kanıt</th>
                          <th>Direk &amp; DTL Tipi</th>
                          <th>Aşama</th>
                          <th>Hakediş Kalemi (Otomatik DTL Metrajı)</th>
                          <th className="num">Miktar</th>
                          <th>Konum Sapması</th>
                          <th>Karar Karnesi</th>
                          <th>Durum</th>
                          {isOwner && <th>Teknik Ofis</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {poolData.items
                          .filter((it) => poolFilter === 'all' || it.status === poolFilter)
                          .map((it) => {
                            const poleObj = data.poles.find((p) => p.idx === it.pole_idx) || {
                              idx: it.pole_idx,
                              name: it.pole_name,
                              tower_type: it.tower_type,
                            };
                            return (
                              <tr key={it.id}>
                                <td>
                                  {it.photo_url ? (
                                    <PhotoImg
                                      url={it.photo_url}
                                      onClick={() =>
                                        setInspectPhoto({
                                          photo: {
                                            id: it.evidence_photo_id,
                                            url: it.photo_url,
                                            decision_status: it.photo_decision_status || 'auto_approved',
                                            decision_score: it.decision_score,
                                            gps_distance_m: it.gps_distance_m,
                                            nearest_pole_name: it.nearest_pole_name,
                                            scorecard: it.photo_scorecard || {},
                                            review_note: it.review_note || '',
                                            stage_label: it.stage_label,
                                          },
                                          pole: poleObj,
                                        })
                                      }
                                    />
                                  ) : (
                                    <span className="muted">—</span>
                                  )}
                                </td>
                                <td>
                                  <b>{it.pole_name}</b>
                                  <div className="muted" style={{ fontSize: 11.5 }}>
                                    {it.tower_type || 'Standart'}
                                    {it.pole_function ? ` (${it.pole_function})` : ''}
                                  </div>
                                </td>
                                <td>
                                  <span
                                    className="badge"
                                    style={{ background: it.stage_color, color: '#fff' }}
                                  >
                                    {it.stage_label}
                                  </span>
                                </td>
                                <td>
                                  <div>{it.item_name}</div>
                                  {it.work_group_code && (
                                    <div className="muted" style={{ fontSize: 11 }}>
                                      İş Grubu: {it.work_group_code} — {it.work_group_name}
                                    </div>
                                  )}
                                </td>
                                <td className="num" style={{ fontWeight: 700 }}>
                                  {Number(it.qty).toLocaleString('tr-TR')} {it.unit}
                                </td>
                                <td>
                                  {it.gps_distance_m != null ? (
                                    <span
                                      style={{
                                        color: it.gps_distance_m <= 55 ? '#16a34a' : '#d97706',
                                        fontWeight: 600,
                                        fontSize: 12.5,
                                      }}
                                    >
                                      Δ {it.gps_distance_m} m
                                    </span>
                                  ) : (
                                    <span className="muted" style={{ fontSize: 11.5 }}>Manuel/Ofis</span>
                                  )}
                                </td>
                                <td>
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    onClick={() =>
                                      it.evidence_photo_id &&
                                      setInspectPhoto({
                                        photo: {
                                          id: it.evidence_photo_id,
                                          url: it.photo_url,
                                          decision_status: it.photo_decision_status || 'auto_approved',
                                          decision_score: it.decision_score,
                                          gps_distance_m: it.gps_distance_m,
                                          nearest_pole_name: it.nearest_pole_name,
                                          scorecard: it.photo_scorecard || {},
                                          review_note: it.review_note || '',
                                          stage_label: it.stage_label,
                                        },
                                        pole: poleObj,
                                      })
                                    }
                                    style={{ fontWeight: 700 }}
                                  >
                                    📋 {it.decision_score}/100
                                  </button>
                                </td>
                                <td>
                                  {it.status === 'ready' && <span className="badge badge-green">🟢 Hakedişe Hazır</span>}
                                  {it.status === 'pending_review' && <span className="badge badge-amber">🟡 İncelemede</span>}
                                  {it.status === 'transferred' && (
                                    <span className="badge badge-blue">
                                      📄 Aktarıldı ({it.payment_period_label || `#${it.payment_period_no}`})
                                    </span>
                                  )}
                                  {it.status === 'rejected' && <span className="badge badge-red">🔴 Reddedildi</span>}
                                </td>
                                {isOwner && (
                                  <td style={{ whiteSpace: 'nowrap' }}>
                                    {it.status !== 'transferred' && (
                                      <div style={{ display: 'flex', gap: 4 }}>
                                        {it.status !== 'ready' && (
                                          <button
                                            className="btn btn-sm btn-success"
                                            onClick={() => handlePoolStatusChange(it.id, 'ready')}
                                            title="Onayla ve Hakediş Havuzuna Al"
                                          >
                                            ✓ Onayla
                                          </button>
                                        )}
                                        {it.status !== 'rejected' && (
                                          <button
                                            className="btn btn-sm btn-danger"
                                            onClick={() => handlePoolStatusChange(it.id, 'rejected')}
                                            title="Reddet"
                                          >
                                            ✕ Red
                                          </button>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
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
        </>
      )}

      {/* MODAL 1: KANITLI SAHA FOTOĞRAFI & AŞAMA DOĞRULAMA */}
      {capturePole && (
        <Modal
          title={`📸 Saha Kanıtı & Doğrulama — ${capturePole.name}`}
          onClose={() => setCapturePole(null)}
        >
          <form onSubmit={submitGuidedCapture}>
            {/* Dijital Direk İkizi Bilgisi */}
            <div
              style={{
                background: 'var(--bg-soft, #f1f5f9)',
                padding: '10px 12px',
                borderRadius: 8,
                marginBottom: 12,
                fontSize: 12.5,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                <span>
                  <b>DTL Dijital İkiz:</b> {capturePole.name} · Tip: <b>{capturePole.tower_type || 'Standart'}</b>
                  {capturePole.pole_function ? ` (${capturePole.pole_function})` : ''}
                </span>
                <span>
                  Mevcut Durum: <b>{statuses[capturePole.status]?.label || 'Başlamadı'}</b>
                </span>
              </div>
              <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                {nearestMatch?.selectedDistanceM != null ? (
                  <span
                    style={{
                      color: nearestMatch.wrongPoleWarning
                        ? '#dc2626'
                        : nearestMatch.selectedDistanceM <= 60
                          ? '#16a34a'
                          : '#d97706',
                      fontWeight: 700,
                    }}
                  >
                    📍 Hedef Direğe Mesafe: Δ {nearestMatch.selectedDistanceM} m
                    {nearestMatch.wrongPoleWarning
                      ? ` (⚠️ Dikkat: Fiziksel olarak ${nearestMatch.nearestPole.name} [${nearestMatch.nearestDistanceM}m] yanındasınız!)`
                      : ' (Konum Doğrulandı)'}
                  </span>
                ) : (
                  <span className="muted">📍 GPS mesafesi doğrulanmadı</span>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => locateNearestPole(false)}
                  disabled={gpsState.loading}
                >
                  {gpsState.loading ? 'Konum Alınıyor…' : '📍 Konumu Yenile'}
                </button>
              </div>
            </div>

            <div className="field">
              <label>Beyan Edilen İmalat Aşaması *</label>
              <select
                value={captureStage}
                onChange={(e) => {
                  setCaptureStage(e.target.value);
                  setCaptureChecklist([]);
                }}
              >
                {Object.entries(statuses)
                  .filter(([k]) => k !== 'none')
                  .map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label} (%{v.progress})
                    </option>
                  ))}
              </select>
            </div>

            {/* Aşamaya Özel Çekim Rehberi & Kontrol Listesi */}
            <div
              style={{
                border: '1px solid var(--border, #dbe2ea)',
                borderRadius: 8,
                padding: '10px 12px',
                marginBottom: 12,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: '#0d1f3c', marginBottom: 4 }}>
                🎯 Çekim Rehberi: {checklistConfig.shotHint}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 8, marginBottom: 4 }}>
                Saha Kalite Kontrol Listesi (Karar Puanına +5 Katkı):
              </div>
              {checklistConfig.items.map((item) => {
                const checked = captureChecklist.includes(item);
                return (
                  <label
                    key={item}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 12.5,
                      padding: '3px 0',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) setCaptureChecklist((prev) => [...prev, item]);
                        else setCaptureChecklist((prev) => prev.filter((x) => x !== item));
                      }}
                    />
                    <span>{item}</span>
                  </label>
                );
              })}
            </div>

            {/* Kamera Çekim Butonu & Önizlemeler */}
            <div className="field">
              <label>Saha Fotoğrafları (EXIF Temizlenir &amp; Koordinatsız Damgalanır) *</label>
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                style={{ display: 'none' }}
                onChange={handleCameraFilesSelected}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-accent"
                  onClick={() => cameraInputRef.current?.click()}
                  disabled={processingPhoto}
                >
                  {processingPhoto ? 'İşleniyor…' : '📷 Kamerayı Aç / Fotoğraf Ekle'}
                </button>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  Açık koordinat yazılmaz; otomatik sıkıştırılır (~350 KB).
                </span>
              </div>

              {processedPhotos.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginTop: 10 }}>
                  {processedPhotos.map((pp, idx) => (
                    <div
                      key={idx}
                      style={{
                        border: pp.blurScore < 25 ? '2px solid #dc2626' : '1px solid #cbd5e1',
                        borderRadius: 8,
                        overflow: 'hidden',
                        background: '#0f172a',
                        color: '#fff',
                        position: 'relative',
                      }}
                    >
                      <img
                        src={pp.previewUrl}
                        alt=""
                        style={{ width: '100%', height: 110, objectFit: 'cover', display: 'block' }}
                      />
                      <div style={{ padding: '4px 8px', fontSize: 11, display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: pp.blurScore < 25 ? '#fca5a5' : '#86efac' }}>
                          Netlik: {pp.blurScore}/100
                        </span>
                        <span>{pp.sizeKb} KB</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setProcessedPhotos((prev) => prev.filter((_, i) => i !== idx))}
                        style={{
                          position: 'absolute',
                          top: 4,
                          right: 4,
                          background: 'rgba(0,0,0,0.7)',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '50%',
                          width: 22,
                          height: 22,
                          cursor: 'pointer',
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Sesli / Yazılı Saha Notu */}
            <div className="field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ marginBottom: 0 }}>Saha Notu</label>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={startVoiceNote}
                  disabled={listeningVoice}
                >
                  {listeningVoice ? '🎙️ Dinleniyor…' : '🎙️ Sesle Yazdır'}
                </button>
              </div>
              <input
                value={captureNote}
                onChange={(e) => setCaptureNote(e.target.value)}
                placeholder="Örn: Ankraj beton dökümü tamamlandı, 4 adet numune alındı…"
                style={{ marginTop: 4 }}
              />
            </div>

            {/* Gönderim sonrası anlık Karar Karnesi (Scorecard) sonucu */}
            {lastDecisionResult?.decision && (
              <div
                style={{
                  border: `2px solid ${DECISION_BADGE[lastDecisionResult.decision.decision_status]?.color || '#16a34a'}`,
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 12,
                  background: 'var(--bg-soft, #f8fafc)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 14 }}>
                    {DECISION_BADGE[lastDecisionResult.decision.decision_status]?.label}
                  </b>
                  <span style={{ fontWeight: 800, fontSize: 15 }}>
                    Kanıt Puanı: {lastDecisionResult.decision.decision_score} / 100
                  </span>
                </div>
                {lastDecisionResult.hakedis_pool_entry && (
                  <div style={{ fontSize: 12.5, marginTop: 6, color: '#0f172a', fontWeight: 600 }}>
                    ✓ Hakediş Havuzu Kaydı: {lastDecisionResult.hakedis_pool_entry.item_name} ({lastDecisionResult.hakedis_pool_entry.qty}{' '}
                    {lastDecisionResult.hakedis_pool_entry.unit})
                  </div>
                )}
                {lastDecisionResult.decision.scorecard?.flags?.length > 0 && (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: '#b91c1c', fontSize: 12 }}>
                    {lastDecisionResult.decision.scorecard.flags.map((fl, i) => (
                      <li key={i}>{fl}</li>
                    ))}
                  </ul>
                )}
                {lastDecisionResult.decision.scorecard?.reasons?.length > 0 && (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: '#15803d', fontSize: 12 }}>
                    {lastDecisionResult.decision.scorecard.reasons.map((rs, i) => (
                      <li key={i}>{rs}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setCapturePole(null)}>
                Kapat
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={processedPhotos.length === 0 || submittingCapture}
              >
                {submittingCapture
                  ? 'Karar Motoru Doğruluyor…'
                  : `🛡️ Doğrula ve Hakediş Havuzuna Gönder (${processedPhotos.length})`}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* MODAL 2: FOTOĞRAF & KANIT KARNESİ DETAY İNCELEME */}
      {inspectPhoto && (
        <Modal
          title={`📋 Kanıt Karnesi — ${inspectPhoto.pole?.name || ''} (${inspectPhoto.photo?.stage_label || 'Saha Fotoğrafı'})`}
          onClose={() => setInspectPhoto(null)}
        >
          <div>
            <div style={{ textAlign: 'center', background: '#0f172a', borderRadius: 8, padding: 8, marginBottom: 12 }}>
              <PhotoImg url={inspectPhoto.photo.url} className="photo-inspect-full" />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <span className={`badge ${DECISION_BADGE[inspectPhoto.photo.decision_status]?.cls || 'badge-green'}`}>
                {DECISION_BADGE[inspectPhoto.photo.decision_status]?.label || inspectPhoto.photo.decision_status}
              </span>
              <span style={{ fontWeight: 800, fontSize: 16 }}>
                Toplam Puan: {inspectPhoto.photo.decision_score} / 100
              </span>
            </div>

            {inspectPhoto.photo.scorecard && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(115px, 1fr))',
                  gap: 8,
                  marginBottom: 12,
                  fontSize: 12,
                }}
              >
                <div className="card" style={{ padding: 8 }}>
                  <div className="muted">📍 Konum Kilidi</div>
                  <b>{inspectPhoto.photo.scorecard.gps_score ?? '—'} / 30</b>
                  {inspectPhoto.photo.gps_distance_m != null && (
                    <div className="muted">Δ {inspectPhoto.photo.gps_distance_m} m</div>
                  )}
                </div>
                <div className="card" style={{ padding: 8 }}>
                  <div className="muted">🔍 Tekillik (pHash)</div>
                  <b>{inspectPhoto.photo.scorecard.phash_score ?? '—'} / 25</b>
                </div>
                <div className="card" style={{ padding: 8 }}>
                  <div className="muted">📷 Netlik &amp; Kalite</div>
                  <b>{inspectPhoto.photo.scorecard.quality_score ?? '—'} / 15</b>
                </div>
                <div className="card" style={{ padding: 8 }}>
                  <div className="muted">🏗️ Görsel Uyum</div>
                  <b>{inspectPhoto.photo.scorecard.visual_score ?? '—'} / 15</b>
                </div>
                <div className="card" style={{ padding: 8 }}>
                  <div className="muted">📐 DTL &amp; Sıra</div>
                  <b>{inspectPhoto.photo.scorecard.dtl_score ?? '—'} / 15</b>
                </div>
              </div>
            )}

            {inspectPhoto.photo.scorecard?.flags?.length > 0 && (
              <div className="form-error" style={{ marginBottom: 10, fontSize: 12 }}>
                <b>Tespit Edilen Uyarı / İhlaller:</b>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {inspectPhoto.photo.scorecard.flags.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {inspectPhoto.photo.scorecard?.reasons?.length > 0 && (
              <div className="notice-banner" style={{ marginBottom: 10, fontSize: 12 }}>
                <b>Doğrulanan Kanıtlar:</b>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {inspectPhoto.photo.scorecard.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {isOwner && (
              <div style={{ borderTop: '1px solid var(--border, #dbe2ea)', paddingTop: 10, marginTop: 10 }}>
                <div className="field">
                  <label>Teknik Ofis İnceleme Notu</label>
                  <input
                    value={reviewNoteInput}
                    onChange={(e) => setReviewNoteInput(e.target.value)}
                    placeholder="Onay veya red gerekçesi…"
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={reviewBusy}
                    onClick={() => handleReviewPhoto(inspectPhoto.photo.id, 'reject')}
                  >
                    ✕ Reddet
                  </button>
                  <button
                    type="button"
                    className="btn btn-success"
                    disabled={reviewBusy}
                    onClick={() => handleReviewPhoto(inspectPhoto.photo.id, 'approve')}
                  >
                    ✓ Onayla ve Hakediş Havuzuna Al
                  </button>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {!data && !busy && (
        <div className="empty">Bu projede gösterilecek veri yok.</div>
      )}
    </div>
  );
}
