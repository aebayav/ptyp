import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import Modal from '../components/Modal';
import { fmtMoney, useProjects, ProjectBar } from '../utils';

export default function FiyatFarki() {
  const { projects, projectId, setProjectId } = useProjects();
  const [indices, setIndices] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ period: '', index_name: 'TUFE', value: '', notes: '' });
  const [autoBusy, setAutoBusy] = useState(false);

  // Hesaplama paneli
  const [indexName, setIndexName] = useState('TUFE');
  const [base, setBase] = useState('');
  const [current, setCurrent] = useState('');
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState(null);
  const [calcErr, setCalcErr] = useState(null);

  async function load() {
    if (projectId == null) return;
    setBusy(true);
    try {
      const d = await api.get(`/api/fiyat-farki?project_id=${projectId}`);
      setIndices(d);
      const periods = [...new Set(d.map((x) => x.period))].sort().reverse();
      if (!base && periods.length >= 2) {
        setBase(periods[1]);
        setCurrent(periods[0]);
      }
      if (d.length > 0) setIndexName(d[0].index_name);
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

  const periods = useMemo(() => [...new Set(indices.map((x) => x.period))].sort().reverse(), [indices]);
  const indexNames = useMemo(() => [...new Set(indices.map((x) => x.index_name))].sort(), [indices]);

  async function saveIndex(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/fiyat-farki', { ...form, project_id: projectId });
      setEditing(false);
      setForm({ period: '', index_name: form.index_name, value: '', notes: '' });
      await load();
      setMsg({ type: 'ok', text: 'Endeks kaydedildi.' });
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  // TCMB EVDS'den otomatik endeks çek — değer alanını doldurur (ve listeye kaydeder)
  async function autoFetch() {
    if (!form.period) {
      setMsg({ type: 'err', text: 'Önce periyot girin (örn. 2026-03).' });
      return;
    }
    setAutoBusy(true);
    setMsg(null);
    try {
      const d = await api.post('/api/fiyat-farki/fetch', {
        project_id: projectId,
        period: form.period.trim(),
        index_name: form.index_name,
      });
      setForm((f) => ({ ...f, value: String(d.value), notes: d.notes || f.notes }));
      await load();
      setMsg({ type: 'ok', text: `Otomatik çekildi: ${d.period} ${d.index_name} = ${d.value} (${d.source})` });
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setAutoBusy(false);
    }
  }

  async function removeIndex(id) {
    if (!window.confirm('Endeks kaydı silinsin mi?')) return;
    try {
      await api.del(`/api/fiyat-farki/${id}`);
      await load();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }

  async function compute() {
    setResult(null);
    setCalcErr(null);
    try {
      const d = await api.get(
        `/api/fiyat-farki/compute?project_id=${projectId}&index_name=${indexName}&base=${base}&current=${current}&amount=${amount}`
      );
      setResult(d);
    } catch (e) {
      setCalcErr(e.message);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Fiyat Farkı</h1>
          <p className="sub">TÜİK endeksleriyle Pn formülü — hakediş fiyat farkı hesabı</p>
        </div>
        <button className="btn btn-accent" onClick={() => setEditing(true)} disabled={projectId == null}>
          + Endeks Ekle
        </button>
      </div>

      <ProjectBar projects={projects} projectId={projectId} onChange={setProjectId} />

      {msg && (
        <div className={msg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Pn Hesabı</h3>
        <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>
          Pn = İn / İo · Fark = Tutar × (Pn − 1)
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 130px' }}>
            <label>Endeks</label>
            <select value={indexName} onChange={(e) => setIndexName(e.target.value)}>
              {[...new Set(['TUFE', ...indexNames])].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 130px' }}>
            <label>Baz Periyot (İo)</label>
            <select value={base} onChange={(e) => setBase(e.target.value)}>
              <option value="">—</option>
              {periods.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 130px' }}>
            <label>Cari Periyot (İn)</label>
            <select value={current} onChange={(e) => setCurrent(e.target.value)}>
              <option value="">—</option>
              {periods.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 150px' }}>
            <label>Hakediş Tutarı (₺)</label>
            <input type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="örn. 2500000" />
          </div>
          <button className="btn btn-primary" onClick={compute} disabled={!base || !current || !amount}>
            Hesapla
          </button>
        </div>
        {calcErr && (
          <div className="form-error" style={{ marginTop: 10 }}>
            {calcErr}
          </div>
        )}
        {result && (
          <div
            style={{
              marginTop: 12,
              padding: '12px 16px',
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent)',
              borderRadius: 10,
              display: 'flex',
              gap: 22,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                Pn ({result.index_name} · {result.current_period} / {result.base_period})
              </div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>
                {result.current_value} / {result.base_value} = <b>{result.pn}</b>
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                Fiyat Farkı
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: result.fark >= 0 ? '#16a34a' : '#dc2626' }}>
                {fmtMoney(result.fark)} (%{result.fark_yuzde})
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Endeks Kayıtları</h3>
        {indices.length === 0 ? (
          <div className="empty">
            Henüz endeks kaydı yok. <b>+ Endeks Ekle</b> ile TÜİK değerlerini girin (ör. periyot 2026-03, TUFE 1125.42).
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Periyot</th>
                  <th>Endeks</th>
                  <th className="num">Değer</th>
                  <th>Not</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {indices.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.period}</td>
                    <td>{r.index_name}</td>
                    <td className="num">{Number(r.value).toLocaleString('tr-TR', { maximumFractionDigits: 4 })}</td>
                    <td className="muted">{r.notes || '—'}</td>
                    <td>
                      <button className="btn btn-sm btn-danger" onClick={() => removeIndex(r.id)}>
                        Sil
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <Modal title="Yeni Endeks" onClose={() => setEditing(false)}>
          <form onSubmit={saveIndex}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div className="field" style={{ flex: '1 1 130px' }}>
                <label>Periyot (YYYY-AA)</label>
                <input value={form.period} onChange={(e) => setForm((f) => ({ ...f, period: e.target.value }))} placeholder="2026-03" required />
              </div>
              <div className="field" style={{ flex: '1 1 110px' }}>
                <label>Endeks</label>
                <select value={form.index_name} onChange={(e) => setForm((f) => ({ ...f, index_name: e.target.value }))}>
                  {['TUFE', 'UFE', 'YI-UFE'].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: '1 1 140px' }}>
                <label>Değer</label>
                <input type="number" step="any" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} placeholder="1125.42" required />
              </div>
              <div className="field" style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
                <button type="button" className="btn" onClick={autoFetch} disabled={autoBusy} title="TCMB EVDS'den resmi TÜİK endeks değerini otomatik çeker">
                  {autoBusy ? 'Çekiliyor…' : 'Otomatik Getir'}
                </button>
              </div>
              <div className="field" style={{ flex: '2 1 180px' }}>
                <label>Not</label>
                <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="TÜİK açıklaması vb." />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
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
