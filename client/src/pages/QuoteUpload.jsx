import { useState } from 'react';
import { fmtMoney } from '../utils';

export default function QuoteUpload() {
  const [firmName, setFirmName] = useState('');
  const [contact, setContact] = useState('');
  const [email, setEmail] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!firmName.trim()) return setError('Lütfen firma adınızı yazın.');
    if (!file) return setError('Lütfen teklif dosyanızı seçin.');
    setBusy(true);
    const fd = new FormData();
    fd.append('firm_name', firmName);
    fd.append('contact', contact);
    fd.append('email', email);
    fd.append('file', file);
    try {
      const res = await fetch('/api/public/quote-upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Yükleme başarısız oldu.');
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="upload-page">
      <div className="upload-head">
        <span className="brand-logo">⚡</span>
        <div>
          <h1>PTYP — Teklif Yükleme</h1>
          <p>Elektrik Nakil Hattı &amp; Trafo Merkezi Projesi</p>
        </div>
      </div>

      <div className="upload-card">
        {!result ? (
          <>
            <h2>Teklif Dosyanızı Yükleyin</h2>
            <p className="upload-sub">
              Firma adınızı yazın, teklif dosyanızı (PDF, Excel, Word, CSV, TXT) seçip gönderin.
              Fiyatlar otomatik okunur ve malzemelerle eşleştirilir.
            </p>

            {error && <div className="form-error">{error}</div>}

            <form onSubmit={submit}>
              <div className="field">
                <label>Firma Adı *</label>
                <input
                  value={firmName}
                  onChange={(e) => setFirmName(e.target.value)}
                  autoFocus
                  placeholder="Örn: Yüksek Gerilim Malzeme A.Ş."
                />
              </div>
              <div className="form-row">
                <div className="field">
                  <label>Yetkili Kişi</label>
                  <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Ad Soyad" />
                </div>
                <div className="field">
                  <label>E-posta</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ornek@firma.com" />
                </div>
              </div>
              <div className="field">
                <label>Teklif Dosyası *</label>
                <label className="file-drop">
                  <input
                    type="file"
                    accept=".pdf,.xlsx,.xls,.docx,.csv,.txt"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                  />
                  <span className="file-drop-ico">📄</span>
                  <span className="file-drop-text">
                    {file ? file.name : 'Dosya seçmek için tıklayın'}
                  </span>
                  <span className="file-drop-hint">PDF · Excel · Word · CSV · TXT (en fazla 10 MB)</span>
                </label>
              </div>
              <button type="submit" className="btn btn-accent login-btn" disabled={busy}>
                {busy ? 'Yükleniyor ve analiz ediliyor…' : 'Teklifi Gönder'}
              </button>
            </form>
          </>
        ) : (
          <div className="upload-result">
            <h2>
              {result.saved_count > 0 ? '✅ Teklifiniz alındı' : '⚠️ Dosya alındı, fiyat eşleşmedi'}
            </h2>
            <p className="upload-sub">
              <strong>{result.firm_name}</strong> — {result.file}
            </p>

            {result.saved_count > 0 ? (
              <>
                <p className="upload-sub">
                  <strong>{result.saved_count} fiyat</strong> tespit edildi ve malzemelere işlendi:
                </p>
                <table className="upload-table">
                  <thead>
                    <tr>
                      <th>Malzeme</th>
                      <th className="num">Tespit Edilen Fiyat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.saved.map((s) => (
                      <tr key={s.id}>
                        <td>{s.material_name}</td>
                        <td className="num">{fmtMoney(s.price, s.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="upload-sub">
                Dosyada sistemdeki malzemelerle eşleşen bir satır bulunamadı. Firma yine de kaydedildi;
                teklifi elle girmek için bizimle iletişime geçin.
              </p>
            )}

            {result.unmatched.length > 0 && (
              <div className="unmatched-box">
                <div className="unmatched-title">Eşleştirilemeyen satırlar:</div>
                {result.unmatched.map((l, i) => (
                  <div key={i} className="unmatched-line">{l}</div>
                ))}
              </div>
            )}

            <button className="btn" onClick={() => { setResult(null); setFile(null); setFirmName(''); setContact(''); setEmail(''); }}>
              ← Başka Teklif Yükle
            </button>
          </div>
        )}
      </div>

      <p className="upload-foot">
        ⚡ PTYP Proje Yönetim Sistemi — teklifler otomatik analiz edilir
      </p>
    </div>
  );
}
