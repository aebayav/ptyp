import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, apiUrl, getToken, isNetworkOrOfflineError } from '../api';
import { useAuth } from '../AuthContext';
import Modal from '../components/Modal';
import { loadLeaflet, useProjects } from '../utils';
import {
  STAGE_CHECKLISTS,
  cacheProjectRequests,
  cacheProjectSahaData,
  enqueueOfflineSubmission,
  findNearestPole,
  getCachedProjectRequests,
  getCachedProjectSahaData,
  listOfflineSubmissions,
  markOfflineSubmissionError,
  patchCachedPoleStatus,
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
        const res = await fetch(apiUrl(url), { headers: { Authorization: 'Bearer ' + getToken() } });
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
  auto_approved: { label: 'Otomatik Onay', cls: 'badge-green', color: '#16a34a' },
  manual_approved: { label: 'Onaylı', cls: 'badge-green', color: '#15803d' },
  needs_review: { label: 'İncelemede', cls: 'badge-amber', color: '#d97706' },
  rejected: { label: 'Reddedildi', cls: 'badge-red', color: '#dc2626' },
  manual_rejected: { label: 'Reddedildi', cls: 'badge-red', color: '#b91c1c' },
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
  const [showOfflineModal, setShowOfflineModal] = useState(false);

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

  // Çevrimdışı / çevrimiçi dinleyicisi ve Service Worker Background Sync mesajı
  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    const onSwMessage = (ev) => {
      if (ev.data?.type === 'PTYP_SYNC_NOW') {
        setIsOnline(true);
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', onSwMessage);
    }
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', onSwMessage);
      }
    };
  }, []);

  // Şebeke geri geldiğinde bekleyen çevrimdışı kayıtları arka planda otomatik gönder
  useEffect(() => {
    if (!isOnline || offlineQueue.length === 0 || syncingOffline) return;
    const t = setTimeout(() => {
      syncOfflineQueueNow(true);
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, offlineQueue.length]);

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
      // Kamulaştırma / izinsiz veya başvuruda olan açıklıkları haritada kırmızı/turuncu vurgula
      const poleByIdx = new Map(data.poles.map((p) => [Number(p.idx), p]));
      for (const par of data.parcels || []) {
        const st = String(par.easement_status || '').toLowerCase();
        if (st !== 'izinsiz' && st !== 'basvuruda') continue;
        const a = poleByIdx.get(Number(par.pole_from_idx));
        const b = poleByIdx.get(Number(par.pole_to_idx));
        if (!a || !b) continue;
        const line = L.polyline(
          [
            [a.lat, a.lon],
            [b.lat, b.lon],
          ],
          {
            color: st === 'izinsiz' ? '#dc2626' : '#d97706',
            weight: 5,
            opacity: 0.9,
            dashArray: st === 'izinsiz' ? '6 4' : '4 4',
          }
        ).addTo(layer);
        line.bindPopup(
          `<b>${st === 'izinsiz' ? '⛔ İzinsiz Parsel Engeli' : '⚠️ İzin Başvuruda'}</b>` +
            `<br>${a.name} → ${b.name}` +
            (par.parcel_no ? `<br>Parsel: <b>${par.parcel_no}</b>` : '') +
            (par.owner_name ? `<br>Malik: ${par.owner_name}` : '')
        );
      }
      for (const p of data.poles) {
        if (filter !== 'all' && p.status !== filter) continue;
        const st = data.statuses[p.status] || data.statuses.none;
        const blk = p.parcel_blocker;
        const m = L.circleMarker([p.lat, p.lon], {
          radius: blk ? 9.5 : 8,
          color: blk ? (blk.severity === 'izinsiz' ? '#dc2626' : '#d97706') : '#ffffff',
          weight: blk ? 2.5 : 1.5,
          fillColor: st.color,
          fillOpacity: 0.95,
        }).addTo(layer);
        m.bindPopup(
          `<b>${p.name}</b><br>${p.tower_type || '—'}` +
            (p.station_text ? ` · ${p.station_text}` : '') +
            `<br>Durum: ${st.label}` +
            (blk ? `<br><span style="color:${blk.severity === 'izinsiz' ? '#dc2626' : '#d97706'};font-weight:700">⛔ ${blk.summary_text}</span>` : '')
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
    if (!capturePole) return;
    if (processedPhotos.length === 0) {
      setSubmittingCapture(true);
      try {
        await saveStatus(capturePole.idx, captureStage, captureNote);
        setCapturePole(null);
      } finally {
        setSubmittingCapture(false);
      }
      return;
    }
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
      if (isNetworkOrOfflineError(err)) {
        const stLabel = data?.statuses?.[captureStage]?.label || captureStage;
        await enqueueOfflineSubmission({
          kind: 'photo',
          projectId,
          poleIdx: capturePole.idx,
          poleName: capturePole.name,
          stage: captureStage,
          stageLabel: stLabel,
          note: captureNote,
          checklist: captureChecklist,
          captureLat: gpsState.lat,
          captureLon: gpsState.lon,
          gpsDistanceM: distM,
          files: processedPhotos.map((p) => p.file),
        });
        await patchCachedPoleStatus(projectId, capturePole.idx, captureStage, stLabel, captureNote);
        setData((prev) =>
          prev
            ? {
                ...prev,
                poles: prev.poles.map((p) =>
                  p.idx === capturePole.idx ? { ...p, status: captureStage, status_label: stLabel, note: captureNote } : p
                ),
              }
            : prev
        );
        await refreshOfflineQueue();
        setCapturePole(null);
        setMsg({
          type: 'ok',
          text: `Çevrimdışı: ${capturePole.name} fotoğrafı kuyruğa kaydedildi. İnternet geldiğinde otomatik gönderilecek.`,
        });
      } else {
        setMsg({ type: 'err', text: 'Gönderim başarısız: ' + (err.message || 'hata') });
      }
    } finally {
      setSubmittingCapture(false);
    }
  }

  async function syncOfflineQueueNow(isAuto = false) {
    if (offlineQueue.length === 0 || syncingOffline) return;
    setSyncingOffline(true);
    let okCount = 0;
    let failCount = 0;
    let lastErrText = '';
    try {
      for (const item of offlineQueue) {
        try {
          const kind = item.kind || 'photo';
          if (kind === 'status') {
            await api.put(`/api/saha/${item.projectId}/status`, {
              pole_idx: item.poleIdx,
              status: item.status || 'none',
              note: item.note ?? '',
            });
          } else if (kind === 'request') {
            await api.post(`/api/saha/${item.projectId}/requests`, item.requestPayload || {});
          } else {
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
          }
          await removeOfflineSubmission(item.id);
          okCount++;
        } catch (itemErr) {
          failCount++;
          lastErrText = itemErr.message || 'Gönderim hatası';
          await markOfflineSubmissionError(item.id, lastErrText);
          if (isNetworkOrOfflineError(itemErr)) break;
        }
      }
      await refreshOfflineQueue();
      if (okCount > 0) {
        await load();
        if (tab === 'pool') await loadPool();
        if (tab === 'requests') await loadRequests();
      }
      if (failCount === 0 && okCount > 0) {
        setShowOfflineModal(false);
        setMsg({
          type: 'ok',
          text: `✓ ${isAuto ? 'Otomatik senkronizasyon: ' : ''}Çevrimdışı kuyruktaki ${okCount} kayıt başarıyla sunucuya aktarıldı.`,
        });
      } else if (failCount > 0 && (!isAuto || okCount > 0)) {
        setMsg({
          type: 'err',
          text: `Senkronizasyon: ${okCount} tamamlandı, ${failCount} kayıt hata verdi (${lastErrText}).`,
        });
      }
    } finally {
      setSyncingOffline(false);
    }
  }

  async function saveStatus(idx, status, note) {
    const poleLabel = pName(idx);
    const stLabel = statuses[status]?.label || status;
    try {
      if (!navigator.onLine) throw new Error('OFFLINE_MODE');
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
      await patchCachedPoleStatus(projectId, idx, d.status, d.status_label, d.note);
      setMsg({ type: 'ok', text: `${poleLabel} güncellendi.` });
    } catch (e) {
      if (isNetworkOrOfflineError(e)) {
        await enqueueOfflineSubmission({
          kind: 'status',
          projectId,
          poleIdx: idx,
          poleName: poleLabel,
          status,
          stageLabel: stLabel,
          note: note ?? '',
        });
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            poles: prev.poles.map((p) => (p.idx === idx ? { ...p, status, status_label: stLabel, note: note ?? '' } : p)),
          };
        });
        await patchCachedPoleStatus(projectId, idx, status, stLabel, note ?? '');
        await refreshOfflineQueue();
        setMsg({
          type: 'ok',
          text: `⚡ Çevrimdışı: ${poleLabel} durumu (${stLabel}) kuyruğa kaydedildi; şebeke geldiğinde gönderilecek.`,
        });
      } else {
        setMsg({ type: 'err', text: e.message });
      }
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
      const res = await fetch(apiUrl(`/api/saha/${projectId}/qr`), {
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
      const list = await api.get(`/api/saha/${projectId}/requests`);
      setRequests(list);
      await cacheProjectRequests(projectId, list);
    } catch (e) {
      const cached = await getCachedProjectRequests(projectId);
      if (cached) {
        setRequests(cached);
      } else {
        setMsg({ type: 'err', text: e.message });
      }
    }
  }

  async function submitRequest(e) {
    e.preventDefault();
    if (!reqForm.item_name.trim()) {
      setMsg({ type: 'err', text: 'Malzeme adı zorunludur.' });
      return;
    }
    try {
      if (!navigator.onLine) throw new Error('OFFLINE_MODE');
      await api.post(`/api/saha/${projectId}/requests`, reqForm);
      setReqForm({ item_name: '', qty: '1', unit: 'adet', pole_ref: '', needed_by: '', note: '' });
      await loadRequests();
      setMsg({ type: 'ok', text: 'Talep iletildi.' });
    } catch (err) {
      if (isNetworkOrOfflineError(err)) {
        await enqueueOfflineSubmission({
          kind: 'request',
          projectId,
          poleName: reqForm.pole_ref || 'Saha',
          itemName: reqForm.item_name.trim(),
          qty: reqForm.qty,
          unit: reqForm.unit,
          requestPayload: { ...reqForm },
        });
        const optimisticReq = {
          id: `offline-${Date.now()}`,
          item_name: reqForm.item_name.trim(),
          qty: reqForm.qty,
          unit: reqForm.unit,
          pole_ref: reqForm.pole_ref,
          needed_by: reqForm.needed_by,
          note: reqForm.note,
          status: 'open',
          requested_by_name: (user?.display_name || user?.username || 'Saha') + ' (Çevrimdışı)',
        };
        const nextReqs = [optimisticReq, ...requests];
        setRequests(nextReqs);
        await cacheProjectRequests(projectId, nextReqs);
        setReqForm({ item_name: '', qty: '1', unit: 'adet', pole_ref: '', needed_by: '', note: '' });
        await refreshOfflineQueue();
        setMsg({
          type: 'ok',
          text: `⚡ Çevrimdışı: "${optimisticReq.item_name}" malzeme talebi kuyruğa alındı; internet geldiğinde iletilecek.`,
        });
      } else {
        setMsg({ type: 'err', text: err.message });
      }
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
            <h1 style={{ margin: 0 }}>Saha</h1>
            <span
              className={`badge ${isOnline ? 'badge-green' : 'badge-amber'}`}
              style={{ fontSize: 11 }}
            >
              {isOnline ? 'Çevrimiçi' : 'Çevrimdışı'}
            </span>
          </div>
          <p className="sub">Direk ilerleme ve saha takibi</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            onClick={() => locateNearestPole(false)}
            disabled={projectId == null || gpsState.loading}
          >
            {gpsState.loading ? 'Aranıyor…' : 'En Yakın Direk'}
          </button>
          <button className="btn" onClick={openQr} disabled={projectId == null} title="Direk QR kartlarını yazdırmak için">
            QR Çıktısı
          </button>
        </div>
      </div>

      {/* Mobil GPS Kartı — En Yakın Direk */}
      {(nearestMatch?.nearestPole || gpsState.error) && (
        <div
          className="card"
          style={{
            marginBottom: 14,
            padding: '10px 14px',
            borderLeft: nearestMatch?.nearestDistanceM <= 60 ? '4px solid #16a34a' : '4px solid #f5a623',
            background: 'var(--bg-soft, #f8fafc)',
          }}
        >
          {gpsState.error ? (
            <div style={{ color: '#dc2626', fontSize: 13 }}>{gpsState.error}</div>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
                  En Yakın Direk
                </div>
                <div style={{ fontSize: 14.5, fontWeight: 700, marginTop: 2 }}>
                  {nearestMatch.nearestPole.name}{' '}
                  <span className="muted" style={{ fontWeight: 500, fontSize: 12.5 }}>
                    ({nearestMatch.nearestPole.tower_type || 'Standart'}
                    {nearestMatch.nearestPole.pole_function ? ` · ${nearestMatch.nearestPole.pole_function}` : ''})
                  </span>
                  {' — '}
                  <span style={{ color: nearestMatch.nearestDistanceM <= 55 ? '#16a34a' : '#d97706' }}>
                    {nearestMatch.nearestDistanceM} m
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
                  Göster
                </button>
                <button
                  className="btn btn-sm btn-accent"
                  onClick={() => openCaptureModal(nearestMatch.nearestPole)}
                >
                  Fotoğraf / Durum
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
            <b>Bekleyen {offlineQueue.length} çevrimdışı kayıt</b>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => setShowOfflineModal(true)}
            >
              Kuyruk ({offlineQueue.length})
            </button>
            <button
              className="btn btn-sm btn-primary"
              type="button"
              onClick={() => syncOfflineQueueNow(false)}
              disabled={!isOnline || syncingOffline}
            >
              {syncingOffline ? 'Gönderiliyor…' : 'Şimdi Gönder'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={projectId ?? ''} onChange={(e) => setProjectId(Number(e.target.value))}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {summary && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            <div className="progress-track mini" style={{ width: 110 }}>
              <div className="progress-fill" style={{ width: `${summary.progress}%` }} />
            </div>
            <span style={{ fontWeight: 700, fontSize: 12.5 }}>%{summary.progress}</span>
            <span className="muted" style={{ fontSize: 12 }}>
              ({summary.pole_count} direk)
            </span>
          </div>
        )}
      </div>

      {msg && (
        <div className={msg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            <button className={`tab-chip ${tab === 'poles' ? 'on' : ''}`} onClick={() => setTab('poles')}>
              Direkler ({data.poles.length})
            </button>
            <button className={`tab-chip ${tab === 'pool' ? 'on' : ''}`} onClick={() => setTab('pool')}>
              Hakediş Havuzu
              {poolCounts.ready + poolCounts.pending_review > 0
                ? ` (${poolCounts.ready + poolCounts.pending_review})`
                : ''}
            </button>
            <button className={`tab-chip ${tab === 'requests' ? 'on' : ''}`} onClick={() => setTab('requests')}>
              Malzeme Talebi{openCount > 0 ? ` (${openCount})` : ''}
            </button>
          </div>

          {tab === 'poles' && (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  style={{ minWidth: 160 }}
                >
                  <option value="all">Tüm Durumlar ({data.poles.length})</option>
                  {summary.status_counts.map((s) => (
                    <option key={s.status} value={s.status}>
                      {s.label} ({s.count})
                    </option>
                  ))}
                </select>
                <input
                  type="search"
                  placeholder="Direk ara (örn: D-47, PE1)…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  style={{ flex: '1 1 180px', padding: '7px 10px', fontSize: 13 }}
                />
              </div>

              {/* Kanton Bazlı Çalışılabilir Cephe Özeti — Daraltılabilir */}
              {data.canton_readiness?.cantons?.length > 0 && (
                <details className="card" style={{ marginBottom: 12, padding: '8px 12px' }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <span>Kanton &amp; Kamulaştırma Durumu</span>
                    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                      <span className="badge badge-green">
                        Açık Cephe: {data.canton_readiness.summary.open_canton_count}/{data.canton_readiness.summary.total_cantons}
                      </span>
                      {data.canton_readiness.summary.blocked_canton_count > 0 && (
                        <span className="badge badge-red">
                          Blokeli: {data.canton_readiness.summary.blocked_canton_count}
                        </span>
                      )}
                    </span>
                  </summary>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                    {data.canton_readiness.cantons.map((c) => {
                      const borderCol =
                        c.readiness_status === 'blocked'
                          ? '#dc2626'
                          : c.readiness_status === 'pending_permit'
                            ? '#d97706'
                            : c.readiness_status === 'ready_for_stringing' || c.readiness_status === 'completed'
                              ? '#16a34a'
                              : '#2563eb';
                      return (
                        <button
                          key={c.index}
                          type="button"
                          className="btn btn-sm"
                          style={{
                            borderLeft: `4px solid ${borderCol}`,
                            fontSize: 11.5,
                            padding: '4px 8px',
                            textAlign: 'left',
                          }}
                          onClick={() => {
                            if (c.fromIdx != null) {
                              setFilter('all');
                              setTimeout(() => {
                                const el = document.getElementById(`pole-row-${c.fromIdx}`);
                                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                setFlashIdx(c.fromIdx);
                              }, 60);
                            }
                          }}
                        >
                          <b>K{c.index}</b> ({c.fromLabel}→{c.toLabel}) · {c.readiness_label}
                        </button>
                      );
                    })}
                  </div>
                </details>
              )}

              <div className="card" style={{ marginBottom: 12, padding: 8 }}>
                <div ref={mapDivRef} className="saha-map" />
              </div>

              <div className="card" style={{ padding: '10px 14px' }}>
                {filteredPoles.map((p) => {
                  const st = statuses[p.status] || statuses.none;
                  const metaParts = [
                    p.tower_type,
                    p.pole_function,
                    p.station_text ? `${p.station_text}` : null,
                  ].filter(Boolean);
                  return (
                    <div key={p.idx} id={`pole-row-${p.idx}`} className={`pole-row ${flashIdx === p.idx ? 'flash' : ''}`}>
                      <div className="pole-row-main">
                        <div className="pole-info">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <b style={{ fontSize: 14 }}>{p.name}</b>
                            {metaParts.length > 0 && (
                              <span className="muted" style={{ fontSize: 12 }}>
                                {metaParts.join(' · ')}
                              </span>
                            )}
                            {p.parcel_blocker && (
                              <span
                                className={`badge ${p.parcel_blocker.severity === 'izinsiz' ? 'badge-red' : 'badge-amber'}`}
                                style={{ fontSize: 10.5 }}
                              >
                                {p.parcel_blocker.summary_text}
                              </span>
                            )}
                          </div>
                          {p.note && (
                            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                              {p.note}
                            </div>
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
                            onClick={() => openCaptureModal(p)}
                          >
                            {p.photos.length > 0 ? `Fotoğraf (${p.photos.length})` : 'Fotoğraf'}
                          </button>
                        </div>
                      </div>

                      {p.photos.length > 0 && (
                        <div className="pole-photos">
                          {p.photos.map((ph) => {
                            const dbadge = DECISION_BADGE[ph.decision_status] || DECISION_BADGE.auto_approved;
                            return (
                              <span
                                key={ph.id}
                                className="photo-wrap"
                                style={{
                                  border: `2px solid ${dbadge.color}`,
                                  borderRadius: 6,
                                  overflow: 'hidden',
                                }}
                              >
                                <PhotoImg
                                  url={ph.url}
                                  onClick={() => {
                                    setInspectPhoto({ photo: ph, pole: p });
                                    setReviewNoteInput(ph.review_note || '');
                                  }}
                                />
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
                    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                    gap: 10,
                    marginBottom: 14,
                  }}
                >
                  <div className="card" style={{ padding: '10px 14px', borderLeft: '4px solid #16a34a' }}>
                    <div className="muted" style={{ fontSize: 11, fontWeight: 700 }}>ONAYLI</div>
                    <div style={{ fontSize: 19, fontWeight: 800, marginTop: 2 }}>{poolData.summary.ready_count}</div>
                  </div>
                  <div className="card" style={{ padding: '10px 14px', borderLeft: '4px solid #d97706' }}>
                    <div className="muted" style={{ fontSize: 11, fontWeight: 700 }}>İNCELEMEDE</div>
                    <div style={{ fontSize: 19, fontWeight: 800, marginTop: 2 }}>{poolData.summary.pending_review_count}</div>
                  </div>
                  <div className="card" style={{ padding: '10px 14px', borderLeft: '4px solid #2563eb' }}>
                    <div className="muted" style={{ fontSize: 11, fontWeight: 700 }}>HAZIR METRAJ</div>
                    <div style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>
                      {poolData.summary.ready_steel_kg.toLocaleString('tr-TR')} kg
                    </div>
                  </div>
                  <div className="card" style={{ padding: '10px 14px', borderLeft: '4px solid #64748b' }}>
                    <div className="muted" style={{ fontSize: 11, fontWeight: 700 }}>AKTARILAN</div>
                    <div style={{ fontSize: 19, fontWeight: 800, marginTop: 2 }}>{poolData.summary.transferred_count}</div>
                  </div>
                </div>
              )}

              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                  <h3 style={{ margin: 0 }}>Hakediş Havuzu</h3>
                  {isOwner && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        className="btn"
                        onClick={() => navigate('/hakedisler')}
                      >
                        Hakedişler →
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={!poolData.summary?.ready_count || transferBusy}
                        onClick={handleTransferPoolToHakedis}
                      >
                        {transferBusy
                          ? 'Aktarılıyor…'
                          : `Hakedişe Aktar (${poolData.summary?.ready_count || 0})`}
                      </button>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                  {[
                    { key: 'all', label: `Tümü (${poolData.items.length})` },
                    { key: 'pending_review', label: `İnceleme (${poolData.summary?.pending_review_count || 0})` },
                    { key: 'ready', label: `Hazır (${poolData.summary?.ready_count || 0})` },
                    { key: 'transferred', label: `Aktarılan (${poolData.summary?.transferred_count || 0})` },
                    { key: 'rejected', label: `Red (${poolData.summary?.rejected_count || 0})` },
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
                  <div className="empty">Henüz kayıt yok.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Fotoğraf</th>
                          <th>Direk</th>
                          <th>Aşama</th>
                          <th>İmalat Kalemi</th>
                          <th className="num">Miktar</th>
                          <th>Sapma</th>
                          <th>Puan</th>
                          <th>Durum</th>
                          {isOwner && <th>İşlem</th>}
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
                                      {it.gps_distance_m} m
                                    </span>
                                  ) : (
                                    <span className="muted" style={{ fontSize: 11.5 }}>Ofis</span>
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
                                    {it.decision_score}/100
                                  </button>
                                </td>
                                <td>
                                  {it.status === 'ready' && <span className="badge badge-green">Hazır</span>}
                                  {it.status === 'pending_review' && <span className="badge badge-amber">İncelemede</span>}
                                  {it.status === 'transferred' && (
                                    <span className="badge badge-blue">
                                      Aktarıldı ({it.payment_period_label || `#${it.payment_period_no}`})
                                    </span>
                                  )}
                                  {it.status === 'rejected' && <span className="badge badge-red">Reddedildi</span>}
                                </td>
                                {isOwner && (
                                  <td style={{ whiteSpace: 'nowrap' }}>
                                    {it.status !== 'transferred' && (
                                      <div style={{ display: 'flex', gap: 4 }}>
                                        {it.status !== 'ready' && (
                                          <button
                                            className="btn btn-sm btn-success"
                                            onClick={() => handlePoolStatusChange(it.id, 'ready')}
                                          >
                                            Onayla
                                          </button>
                                        )}
                                        {it.status !== 'rejected' && (
                                          <button
                                            className="btn btn-sm btn-danger"
                                            onClick={() => handlePoolStatusChange(it.id, 'rejected')}
                                          >
                                            Red
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

      {/* MODAL 1: SAHA FOTOĞRAFI & DURUM GÜNCELLEME */}
      {capturePole && (
        <Modal
          title={`${capturePole.name} — Durum & Fotoğraf`}
          onClose={() => setCapturePole(null)}
        >
          <form onSubmit={submitGuidedCapture}>
            {capturePole.parcel_blocker && (
              <div
                className={capturePole.parcel_blocker.severity === 'izinsiz' ? 'form-error' : 'notice-banner'}
                style={{ marginBottom: 10, fontSize: 12.5 }}
              >
                <b>Kamulaştırma Uyarısı:</b> {capturePole.parcel_blocker.summary_text}
              </div>
            )}
            <div
              style={{
                background: 'var(--bg-soft, #f1f5f9)',
                padding: '8px 12px',
                borderRadius: 8,
                marginBottom: 12,
                fontSize: 12.5,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 6,
              }}
            >
              <span>
                <b>{capturePole.name}</b> ({capturePole.tower_type || 'Standart'})
              </span>
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
                  Mesafe: {nearestMatch.selectedDistanceM} m
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => locateNearestPole(false)}
                  disabled={gpsState.loading}
                >
                  {gpsState.loading ? 'Alınıyor…' : 'Konum Al'}
                </button>
              )}
            </div>

            <div className="field">
              <label>İmalat Aşaması</label>
              <select
                value={captureStage}
                onChange={(e) => {
                  setCaptureStage(e.target.value);
                  setCaptureChecklist([]);
                }}
              >
                {Object.entries(statuses).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label} (%{v.progress})
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>Fotoğraf (Opsiyonel)</label>
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                style={{ display: 'none' }}
                onChange={handleCameraFilesSelected}
              />
              <button
                type="button"
                className="btn btn-accent"
                onClick={() => cameraInputRef.current?.click()}
                disabled={processingPhoto}
              >
                {processingPhoto ? 'İşleniyor…' : 'Fotoğraf Çek / Seç'}
              </button>

              {processedPhotos.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginTop: 10 }}>
                  {processedPhotos.map((pp, idx) => (
                    <div
                      key={idx}
                      style={{
                        border: '1px solid #cbd5e1',
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
                        style={{ width: '100%', height: 90, objectFit: 'cover', display: 'block' }}
                      />
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

            <div className="field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ marginBottom: 0 }}>Saha Notu</label>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={startVoiceNote}
                  disabled={listeningVoice}
                >
                  {listeningVoice ? 'Dinleniyor…' : 'Sesle Yaz'}
                </button>
              </div>
              <input
                value={captureNote}
                onChange={(e) => setCaptureNote(e.target.value)}
                placeholder="Örn: Beton dökümü tamamlandı…"
                style={{ marginTop: 4 }}
              />
            </div>

            {lastDecisionResult?.decision && (
              <div
                style={{
                  border: `2px solid ${DECISION_BADGE[lastDecisionResult.decision.decision_status]?.color || '#16a34a'}`,
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 12,
                  background: 'var(--bg-soft, #f8fafc)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 13.5 }}>
                    {DECISION_BADGE[lastDecisionResult.decision.decision_status]?.label}
                  </b>
                  <span style={{ fontWeight: 700, fontSize: 13.5 }}>
                    Puan: {lastDecisionResult.decision.decision_score} / 100
                  </span>
                </div>
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setCapturePole(null)}>
                Kapat
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={submittingCapture}
              >
                {submittingCapture
                  ? 'Kaydediliyor…'
                  : processedPhotos.length > 0
                    ? `Fotoğraflı Kaydet (${processedPhotos.length})`
                    : 'Durumu Kaydet'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* MODAL 2: FOTOĞRAF DETAY İNCELEME */}
      {inspectPhoto && (
        <Modal
          title={`${inspectPhoto.pole?.name || ''} — ${inspectPhoto.photo?.stage_label || 'Saha Fotoğrafı'}`}
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
              <span style={{ fontWeight: 700, fontSize: 14 }}>
                Puan: {inspectPhoto.photo.decision_score} / 100
                {inspectPhoto.photo.gps_distance_m != null ? ` · ${inspectPhoto.photo.gps_distance_m} m` : ''}
              </span>
            </div>

            {inspectPhoto.photo.scorecard?.flags?.length > 0 && (
              <div className="form-error" style={{ marginBottom: 10, fontSize: 12 }}>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {inspectPhoto.photo.scorecard.flags.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {isOwner && (
              <div style={{ borderTop: '1px solid var(--border, #dbe2ea)', paddingTop: 10, marginTop: 10 }}>
                <div className="field">
                  <label>İnceleme Notu</label>
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
                    Reddet
                  </button>
                  <button
                    type="button"
                    className="btn btn-success"
                    disabled={reviewBusy}
                    onClick={() => handleReviewPhoto(inspectPhoto.photo.id, 'approve')}
                  >
                    Onayla
                  </button>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* MODAL 3: ÇEVRİMDIŞI KUYRUK YÖNETİMİ */}
      {showOfflineModal && (
        <Modal
          title={`Çevrimdışı Kuyruk (${offlineQueue.length})`}
          onClose={() => setShowOfflineModal(false)}
        >
          <div>
            {offlineQueue.length === 0 ? (
              <div className="empty">Bekleyen çevrimdışı kayıt yok.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto', marginBottom: 12 }}>
                {offlineQueue.map((item) => {
                  const kind = item.kind || 'photo';
                  const kindBadge =
                    kind === 'status'
                      ? { label: 'Durum', cls: 'badge-blue' }
                      : kind === 'request'
                        ? { label: 'Talep', cls: 'badge-amber' }
                        : { label: `Fotoğraf (${item.files?.length || 1})`, cls: 'badge-green' };
                  return (
                    <div
                      key={item.id}
                      style={{
                        border: item.lastError ? '1px solid #dc2626' : '1px solid var(--border, #dbe2ea)',
                        borderRadius: 8,
                        padding: '8px 12px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span className={`badge ${kindBadge.cls}`} style={{ fontSize: 11 }}>
                            {kindBadge.label}
                          </span>
                          <b>{item.poleName || `D-${item.poleIdx}`}</b>
                          {item.stageLabel && <span className="muted">· {item.stageLabel}</span>}
                          {kind === 'request' && (
                            <span>
                              · <b>{item.itemName}</b> ({item.qty} {item.unit})
                            </span>
                          )}
                        </div>
                        {item.lastError && (
                          <div style={{ color: '#dc2626', fontSize: 11.5, marginTop: 2, fontWeight: 600 }}>
                            Hata: {item.lastError}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={async () => {
                          await removeOfflineSubmission(item.id);
                          await refreshOfflineQueue();
                        }}
                      >
                        Sil
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setShowOfflineModal(false)}>
                Kapat
              </button>
              {offlineQueue.length > 0 && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!isOnline || syncingOffline}
                  onClick={() => syncOfflineQueueNow(false)}
                >
                  {syncingOffline ? 'Gönderiliyor…' : isOnline ? 'Tümünü Gönder' : 'Şebeke Bekleniyor'}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {!data && !busy && (
        <div className="empty">Bu projede gösterilecek veri yok.</div>
      )}
    </div>
  );
}
