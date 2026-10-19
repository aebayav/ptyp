import { useEffect, useState } from 'react';
import { api, apiDownload, getToken } from '../api';
import { okumaBilgisi } from '../utils';

// POST ile dosya indirme (Bearer token ile blob)
async function postDownload(path, body, filename) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || 'İndirme başarısız.');
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function DocumentKmz() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [file, setFile] = useState(null);
  const [files, setFiles] = useState([]);
  const [result, setResult] = useState(null);
  const [rows, setRows] = useState([]);
  const [preview, setPreview] = useState(null);
  const [utmZone, setUtmZone] = useState('0'); // her zaman otomatik algıla (il tablosu + doğrulama)
  const [batchProgress, setBatchProgress] = useState(null); // {done, total, log: []}

  useEffect(() => {
    api.get('/api/projects')
      .then((p) => {
        setProjects(p);
        setProjectId(p[0]?.id ?? null);
      })
      .catch(() => {});
  }, []);

  function removeFile(i) {
    setFiles((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      setFile(next.length === 1 ? next[0] : null);
      return next;
    });
    setMsg(null);
  }

  function moveFile(i, dir) {
    setFiles((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      setFile(next.length === 1 ? next[0] : null);
      return next;
    });
  }

  // Toplu belge işleme: dosyalar sırayla okunur, direkler birleştirilir
  async function parseBatch() {
    if (files.length < 2 || projectId == null) return;
    setBusy(true);
    setMsg(null);
    setResult(null);
    setPreview(null);
    setRows([]);
    const log = [];
    const collected = [];
    let firstPreview = null;
    let batchCmUsed = null;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setBatchProgress({ done: i, total: files.length, log });
      const fd = new FormData();
      fd.append('project_id', projectId);
      fd.append('file', f);
      fd.append('tm3_cm', batchCmUsed ?? (utmZone === '0' ? 0 : utmZone));
      try {
        const res = await fetch('/api/kmz-generator/parse', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + getToken() },
          body: fd,
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'Okuma başarısız.');
        collected.push(d);
        if (!batchCmUsed && d.tm3_cm_used) batchCmUsed = d.tm3_cm_used;
        if (!firstPreview && d.ocr?.pages?.length) firstPreview = d.ocr.pages[0].preview;
        const domInfo = d.tm3_cm_used ? ` (DOM ${d.tm3_cm_used}°)` : '';
        log.push(`${i + 1}/${files.length} · ${f.name}: ${d.count} direk${domInfo} ✓`);
        console.log(`[Belge→KMZ batch ${i + 1}/${files.length}]`, okumaBilgisi(d));
      } catch (e) {
        log.push(`${i + 1}/${files.length} · ${f.name}: HATA — ${e.message}`);
      }
      setBatchProgress({ done: i + 1, total: files.length, log });
    }
    setBatchProgress(null);
    // Birleştir: sayfa geçişlerinde tekrarlanan aynı direkleri (≈25m) veya birebir aynı koordinatı (≈2m) ele
    const all = collected.flatMap((d) => d.poles || []);
    const merged = [];
    for (const p of all) {
      const pName = String(p.name || '').trim().toUpperCase();
      const dup = merged.some((q) => {
        const qName = String(q.name || '').trim().toUpperCase();
        const distM = Math.hypot((p.lat - q.lat) * 110900, (p.lon - q.lon) * 87300);
        return pName && pName === qName ? distM < 25 : distM < 2;
      });
      if (!dup) merged.push(p);
    }
    if (merged.length < 2) {
      setMsg({ type: 'err', text: `Toplu işleme tamamlandı ama birleştirilebilir direk bulunamadı (${log.filter((l) => l.includes('HATA')).length} hata).` });
      setBusy(false);
      return;
    }
    setResult({ count: merged.length, poles: merged, file_name: `${files.length} belge` });
    setRows(merged.map((p) => ({ name: p.name, lat: String(p.lat), lon: String(p.lon) })));
    if (firstPreview) setPreview(firstPreview);
    const hatalar = log.filter((l) => l.includes('HATA')).length;
    setMsg({
      type: 'ok',
      text: `${files.length} belge işlendi → ${merged.length} direk birleştirildi` + (hatalar > 0 ? ` · ${hatalar} belge okunamadı` : '') + ' — kontrol edip KMZ üretin',
    });
    setBusy(false);
  }

  async function parseFile() {
    if (!file || projectId == null) return;
    setBusy(true);
    setMsg(null);
    setResult(null);
    setPreview(null);
    setRows([]);
    const fd = new FormData();
    fd.append('project_id', projectId);
    fd.append('file', file);
    fd.append('tm3_cm', utmZone === '0' ? 0 : utmZone);
    try {
      const res = await fetch('/api/kmz-generator/parse', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: fd,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Okuma başarısız.');
      setResult(d);
      setRows(d.poles.map((p) => ({ name: p.name, lat: String(p.lat), lon: String(p.lon) })));
      if (d.ocr?.pages?.length) setPreview(d.ocr.pages[0].preview);
      const uncertainCount = d.ocr?.uncertain?.length || 0;
      setMsg({
        type: 'ok',
        text:
          `${d.count} direk bulundu` +
          (d.tm3_cm_used ? ` · DOM ${d.tm3_cm_used}°` : '') +
          (uncertainCount > 0 ? ` · ${uncertainCount} satır düşük güvenle okundu — aşağıdan kontrol edin` : '') +
          (d.saved > 0 ? ` · projeye ön aktarım yapıldı (${d.saved})` : ''),
      });
      console.log('[Belge→KMZ]', okumaBilgisi(d));
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  function updateRow(i, field, value) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  }
  function deleteRow(i) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }
  function addRow() {
    setRows((prev) => [...prev, { name: '', lat: '', lon: '' }]);
  }

  function downloadCsv() {
    const head = 'Sıra;Direk;Enlem;Boylam\n';
    const body = rows.map((r, i) => `${i + 1};${r.name};${r.lat};${r.lon}`).join('\n');
    const blob = new Blob(['\ufeff' + head + body], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'direkler.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function downloadExcel() {
    try {
      await postDownload('/api/kmz-generator/export-rows', { poles: rows }, 'direkler-duzeltilmis.xlsx');
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  async function submitRows() {
    if (projectId == null) return;
    const valid = rows
      .map((r) => ({ name: r.name.trim(), lat: Number(r.lat), lon: Number(r.lon) }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    if (valid.length < 2) {
      setMsg({ type: 'err', text: 'En az 2 geçerli satır (enlem + boylam) gerekli.' });
      return;
    }
    setBusy(true);
    try {
      const d = await api.post('/api/kmz-generator/from-rows', {
        project_id: projectId,
        doc_name:
          files.length > 1
            ? `${files.length}-belge`
            : file
              ? file.name.replace(/\.[^.]+$/, '')
              : 'belge',
        poles: valid,
      });
      setResult((prev) => ({ ...prev, kmz: d.kmz }));
      setMsg({ type: 'ok', text: `${d.saved} direk kaydedildi · hat ${d.connection_km} km — KMZ hazır.` });
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Belge → KMZ</h1>
          <p className="sub">PDF (metin veya taranmış), TIFF ve Excel'den direk koordinatlarını okuyup KMZ üretin</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>PROJE:</span>
        <select value={projectId ?? ''} onChange={(e) => setProjectId(Number(e.target.value))}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>DİLİM ORTA MERİDYENİ (ITRF-96 3°):</span>
        <select value={utmZone} onChange={(e) => setUtmZone(e.target.value)}>
          <option value="0">Otomatik (İl/İlçe Tablosu + Koordinat Doğrulama)</option>
          <option value="27">DOM 27° (İzmir, Aydın, Muğla, Manisa, Balıkesir, Çanakkale, Edirne, Tekirdağ)</option>
          <option value="30">DOM 30° (İstanbul, Bursa, Kocaeli, Sakarya, Eskişehir, Afyon, Antalya, Denizli)</option>
          <option value="33">DOM 33° (Ankara, Konya, Bolu, Zonguldak, Kastamonu, Kırıkkale, Aksaray, Karaman)</option>
          <option value="36">DOM 36° (Adana, Mersin, Hatay, Gaziantep, K.Maraş, Kayseri, Sivas, Samsun, Çorum)</option>
          <option value="39">DOM 39° (Diyarbakır Merkez/Batı, Şanlıurfa, Malatya, Elazığ, Adıyaman, Trabzon, Ordu, Erzincan)</option>
          <option value="42">DOM 42° (Diyarbakır Doğu/Lice-Silvan-Bismil, Erzurum, Van, Mardin, Batman, Siirt, Şırnak, Muş, Bitlis, Kars, Ağrı)</option>
          <option value="45">DOM 45° (Hakkari, Iğdır)</option>
        </select>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <label
            className="file-drop"
            style={{ flex: 1, minWidth: 260, display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', border: '1.5px dashed var(--border)', borderRadius: 10, cursor: 'pointer' }}
          >
            <input
              type="file"
              accept=".xlsx,.xls,.pdf,.tif,.tiff"
              multiple
              onChange={(e) => {
                const picked = [...(e.target.files || [])];
                if (!picked.length) return;
                setFiles((prev) => {
                  // aynı dosya iki kez eklenmesin (ad + boyut)
                  const next = [...prev];
                  for (const f of picked) {
                    if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
                  }
                  setFile(next.length === 1 ? next[0] : null);
                  return next;
                });
                setMsg(null);
                e.target.value = '';
              }}
            />
            <span className="file-drop-ico"></span>
            <span className="file-drop-text" style={{ flex: 1, textAlign: 'left' }}>
              {files.length > 0
                ? `Listeye ${files.length} belge eklendi — devam etmek için tekrar tıklayın`
                : 'Belge ekle — Excel, PDF veya TIFF; birden çok seçilebilir, tek tek de eklenebilir…'}
            </span>
          </label>
          <button className="btn btn-accent" onClick={files.length > 1 ? parseBatch : parseFile} disabled={busy || files.length === 0 || projectId == null}>
            {busy
              ? batchProgress
                ? `İşleniyor ${batchProgress.done}/${batchProgress.total}…`
                : 'Okunuyor (OCR sürebilir)…'
              : files.length > 1
                ? `Toplu İşle (${files.length} belge)`
                : 'Oku ve Analiz Et'}
          </button>
        </div>
        {files.length > 0 && (
          <div className="card" style={{ marginTop: 10, marginBottom: 0, padding: 10 }}>
            <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              İŞLEME SIRASI — oklarla değiştirin, sil ile çıkarın
            </div>
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: i === files.length - 1 ? 'none' : '1px solid var(--border)' }}>
                <span style={{ minWidth: 22, fontWeight: 700, color: 'var(--muted)' }}>{i + 1}.</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <button className="btn btn-sm" onClick={() => moveFile(i, -1)} disabled={i === 0 || busy} title="Yukarı taşı">↑</button>
                <button className="btn btn-sm" onClick={() => moveFile(i, 1)} disabled={i === files.length - 1 || busy} title="Aşağı taşı">↓</button>
                <button className="btn btn-sm btn-danger" onClick={() => removeFile(i)} disabled={busy} title="Listeden çıkar">Sil</button>
              </div>
            ))}
          </div>
        )}
        {batchProgress && (
          <div className="notice-banner" style={{ marginTop: 10, marginBottom: 0, whiteSpace: 'pre-wrap', fontSize: 12.5 }}>
            {batchProgress.log.join('\n')}
          </div>
        )}
        {msg && (
          <div className={msg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginTop: 10, marginBottom: 0 }}>
            {msg.text}
          </div>
        )}
      </div>

      {preview && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Belge Önizleme</h3>
          <div style={{ maxHeight: 360, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            <img src={preview} alt="Belge önizleme" style={{ display: 'block', maxWidth: '100%' }} />
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>Sonuç Tablosu — hatalı satırları düzeltin</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-sm" onClick={downloadCsv}>CSV İndir</button>
              <button className="btn btn-sm" onClick={downloadExcel}>Excel İndir</button>
              <button className="btn btn-sm" onClick={addRow}>+ Satır Ekle</button>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Direk</th>
                  <th className="num">Enlem</th>
                  <th className="num">Boylam</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="num muted">{i + 1}</td>
                    <td>
                      <input value={r.name} onChange={(e) => updateRow(i, 'name', e.target.value)} style={{ width: '100%' }} />
                    </td>
                    <td>
                      <input type="number" step="any" value={r.lat} onChange={(e) => updateRow(i, 'lat', e.target.value)} style={{ width: 130 }} />
                    </td>
                    <td>
                      <input type="number" step="any" value={r.lon} onChange={(e) => updateRow(i, 'lon', e.target.value)} style={{ width: 130 }} />
                    </td>
                    <td>
                      <button className="btn btn-sm btn-danger" onClick={() => deleteRow(i)} title="Satırı sil">Sil</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-accent" onClick={submitRows} disabled={busy}>
              {busy ? 'Kaydediliyor…' : 'KMZ Üret ve Projeye Aktar'}
            </button>
            {result?.kmz && (
              <button className="btn" onClick={() => apiDownload(result.kmz, 'olusturulan.kmz')}>Oluşan KMZ'yi İndir</button>
            )}
          </div>
          <div className="form-hint" style={{ marginTop: 8 }}>
            KMZ üretildikten sonra haritada görmek için: <strong>İş Takibi &amp; Güzergah Güzergah &amp; Harita</strong>
          </div>
        </div>
      )}
    </div>
  );
}
