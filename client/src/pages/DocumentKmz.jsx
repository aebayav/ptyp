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
  const [result, setResult] = useState(null);
  const [rows, setRows] = useState([]);
  const [preview, setPreview] = useState(null);
  const [utmZone, setUtmZone] = useState('0'); // 0 = otomatik (WGS84 UTM)

  useEffect(() => {
    api.get('/api/projects')
      .then((p) => {
        setProjects(p);
        setProjectId(p[0]?.id ?? null);
      })
      .catch(() => {});
  }, []);

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
    fd.append('utm_zone', utmZone.startsWith('t') ? 0 : utmZone);
    fd.append('tm3_cm', utmZone.startsWith('t') ? utmZone.slice(1) : 0);
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
        doc_name: file ? file.name.replace(/\.[^.]+$/, '') : 'belge',
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
          <h1>Belge KMZ</h1>
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
        <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>KOORDİNAT:</span>
        <select value={utmZone} onChange={(e) => setUtmZone(e.target.value)} title="Koordinat sistemi">
          <option value="0">Otomatik (WGS84 → UTM)</option>
          <option value="37">UTM Zone 37</option>
          <option value="t42">ITRF-96 3°TM (CM 42)</option>
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
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                setMsg(null);
              }}
            />
            <span className="file-drop-ico"></span>
            <span className="file-drop-text" style={{ flex: 1, textAlign: 'left' }}>
              {file ? file.name : 'Excel, PDF veya TIFF seçin — metin katmanı, taranmış belge, OCR otomatik seçilir…'}
            </span>
          </label>
          <button className="btn btn-accent" onClick={parseFile} disabled={busy || !file || projectId == null}>
            {busy ? 'Okunuyor (OCR sürebilir)…' : 'Oku ve Analiz Et'}
          </button>
        </div>
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
                      <button className="btn btn-sm btn-danger" onClick={() => deleteRow(i)} title="Satırı sil"></button>
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
