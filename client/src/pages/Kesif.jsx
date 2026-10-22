import { useEffect, useState } from 'react';
import { api, apiDownload } from '../api';
import { fmtDate, fmtMoney } from '../utils';

const UNITS = ['adet', 'm', 'km', 'kg', 'ton', 'takım', 'set', 'varil'];

const SOURCE_TR = {
  excel: 'Excel dosyası',
  'pdf-text': 'PDF (metin katmanı)',
  'pdf-ocr': 'PDF (OCR)',
  'tiff-ocr': 'TIFF (OCR)',
  batch: 'Toplu belge (birleştirilmiş)',
};

function fmtNum(v) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('tr-TR', { maximumFractionDigits: 3 });
}

export default function Kesif() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [data, setData] = useState(null); // { project_name, dtl, summary, items }
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    api
      .get('/api/projects')
      .then((p) => {
        setProjects(p);
        setProjectId(p[0]?.id ?? null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (projectId == null) return;
    setBusy(true);
    setMsg(null);
    setData(null);
    api
      .get(`/api/kesif/${projectId}`)
      .then(setData)
      .catch((e) => {
        setData(null);
        setMsg({ type: 'err', text: e.message });
      })
      .finally(() => setBusy(false));
  }, [projectId]);

  function updateItem(i, field, value) {
    setData((prev) => {
      if (!prev) return prev;
      const items = prev.items.map((it, idx) => (idx === i ? { ...it, [field]: value } : it));
      return { ...prev, items };
    });
  }

  function addItem() {
    setData((prev) =>
      prev
        ? { ...prev, items: [...prev.items, { item_name: '', unit: 'adet', qty: 0, unit_price: 0, notes: '' }] }
        : prev
    );
  }

  function removeItem(i) {
    setData((prev) => (prev ? { ...prev, items: prev.items.filter((_, idx) => idx !== i) } : prev));
  }

  async function saveItems() {
    if (!data) return;
    const items = data.items
      .map((it) => ({
        item_name: String(it.item_name || '').trim(),
        unit: String(it.unit || 'adet').trim() || 'adet',
        qty: Number(it.qty) || 0,
        unit_price: Number(it.unit_price) || 0,
        notes: String(it.notes || ''),
      }))
      .filter((it) => it.item_name);
    if (items.length === 0 && data.items.length > 0) {
      setMsg({ type: 'err', text: 'Kaydedilecek kalem yok — kalem adlarını doldurun.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const d = await api.put(`/api/kesif/${projectId}/items`, { items });
      setData((prev) => ({ ...prev, items: d.items }));
      setMsg({ type: 'ok', text: `${d.items.length} kalem kaydedildi.` });
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    if (
      !window.confirm(
        'Keşif kalemleri DTL verisinden yeniden üretilecek — mevcut düzenlemeleriniz (birim fiyatlar dahil) silinecek. Devam edilsin mi?'
      )
    )
      return;
    setBusy(true);
    setMsg(null);
    try {
      const d = await api.post(`/api/kesif/${projectId}/regenerate`);
      setData((prev) => ({ ...prev, items: d.items, summary: d.summary }));
      setMsg({ type: 'ok', text: `${d.row_count} DTL satırından ${d.items.length} kalem üretildi.` });
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function exportExcel() {
    try {
      const fname = `kesif-${(data?.project_name || projectId || '').replace(/[\\/:*?"<>|]+/g, '_')}.xlsx`;
      await apiDownload(`/api/kesif/${projectId}/export`, fname);
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  const items = data?.items || [];
  const total = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
  const hasDtl = data && data.dtl.row_count > 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Keşif</h1>
          <p className="sub">DTL'den otomatik keşif özeti</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
          PROJE:
        </span>
        <select value={projectId ?? ''} onChange={(e) => setProjectId(Number(e.target.value))}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {msg && (
        <div className={msg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {data && !hasDtl && (
        <div className="notice-banner" style={{ marginBottom: 12 }}>
          DTL verisi yok. Önce <b>Belge → KMZ</b>'de belgeyi işleyin — keşif kalemleri otomatik üretilir.
        </div>
      )}

      {data && hasDtl && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>
            {data.dtl.header.line_name || data.dtl.header.title || 'DTL Özeti'}
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {data.dtl.header.voltage_kv && <span className="badge badge-blue">{data.dtl.header.voltage_kv}</span>}
            {data.dtl.header.conductor && <span className="badge badge-gray">{data.dtl.header.conductor}</span>}
            {data.dtl.file_name && <span className="badge badge-gray">{data.dtl.file_name}</span>}
            <span className="badge badge-gray">{SOURCE_TR[data.dtl.source] || data.dtl.source || 'Belge'}</span>
          </div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            <b>{data.summary.pole_count}</b> direk
            {data.summary.portal_count > 0 && (
              <>
                {' '}
                · <b>{data.summary.portal_count}</b> portal
              </>
            )}
            {data.summary.total_span_m > 0 && <> · hat uzunluğu ≈ <b>{fmtNum(data.summary.total_span_m / 1000)} km</b></>}
            {data.summary.station_from != null && data.summary.station_to != null && (
              <>
                {' '}
                · istasyon {fmtNum(data.summary.station_from)} m → {fmtNum(data.summary.station_to)} m
              </>
            )}{' '}
            · güncelleme: {fmtDate(data.dtl.updated_at)}
          </div>
          {data.summary.type_counts.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                DİREK TİPİ DAĞILIMI
              </div>
              <div className="table-wrap" style={{ maxHeight: 200 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Direk Tipi</th>
                      <th className="num">Adet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.summary.type_counts.map((t) => (
                      <tr key={t.type}>
                        <td>{t.type}</td>
                        <td className="num">{t.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {data && (
        <div className="card">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 10,
              marginBottom: 10,
            }}
          >
            <h3 style={{ margin: 0 }}>Keşif Kalemleri</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-sm" onClick={addItem} disabled={busy}>
                + Kalem Ekle
              </button>
              <button className="btn btn-sm" onClick={regenerate} disabled={busy || !hasDtl} title="DTL'den yeniden üretir">
                DTL'den Yenile
              </button>
              <button className="btn btn-sm" onClick={exportExcel} disabled={busy || items.length === 0}>
                Excel İndir
              </button>
              <button className="btn btn-sm btn-accent" onClick={saveItems} disabled={busy}>
                {busy ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>İş Kalemi</th>
                  <th>Birim</th>
                  <th className="num">Miktar</th>
                  <th className="num">Birim Fiyat (₺)</th>
                  <th className="num">Tutar (₺)</th>
                  <th>Not</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const amount = (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
                  return (
                    <tr key={it.id ?? `new-${i}`}>
                      <td className="num muted">{i + 1}</td>
                      <td>
                        <input
                          value={it.item_name}
                          onChange={(e) => updateItem(i, 'item_name', e.target.value)}
                          placeholder="İş kalemi adı"
                          style={{ width: '100%', minWidth: 280 }}
                        />
                      </td>
                      <td>
                        <select value={it.unit || 'adet'} onChange={(e) => updateItem(i, 'unit', e.target.value)}>
                          {UNITS.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="number"
                          step="any"
                          value={it.qty ?? 0}
                          onChange={(e) => updateItem(i, 'qty', e.target.value)}
                          style={{ width: 110 }}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          value={it.unit_price ?? 0}
                          onChange={(e) => updateItem(i, 'unit_price', e.target.value)}
                          style={{ width: 110 }}
                        />
                      </td>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        {fmtMoney(amount)}
                      </td>
                      <td>
                        <input
                          value={it.notes || ''}
                          onChange={(e) => updateItem(i, 'notes', e.target.value)}
                          placeholder="-"
                          style={{ width: '100%', minWidth: 160 }}
                        />
                      </td>
                      <td>
                        <button className="btn btn-sm btn-danger" onClick={() => removeItem(i)} disabled={busy} title="Kalemi sil">
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 18 }}>
                      {busy ? 'Yükleniyor…' : 'Kalem yok — "DTL\'den Yenile" ile üretin.'}
                    </td>
                  </tr>
                )}
              </tbody>
              {items.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'right', fontWeight: 700 }}>
                      TOPLAM
                    </td>
                    <td className="num" style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {fmtMoney(total)}
                    </td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
