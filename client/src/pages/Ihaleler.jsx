import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtDate } from '../utils';

// İhale Kutusu — EKAP'tan bookmarklet hasadıyla gelen ihaleler.
// Kurulum kartı: bookmarklet'i yer imlerine ekle → EKAP aramayı aç → tek tık →
// kutu tazelenir. "Tarama uyuyor" çipi >48 sa bayatlamayı görünür kılar.
export default function Ihaleler() {
  const [rows, setRows] = useState(null);
  const [stats, setStats] = useState(null);
  const [queries, setQueries] = useState([]);
  const [bm, setBm] = useState(null); // { code, ekap_url, token_suffix }
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [newQuery, setNewQuery] = useState('');
  const [msg, setMsg] = useState(null);

  async function load() {
    try {
      setError(null);
      const [r, s, q, b] = await Promise.all([
        api.get('/api/ihaleler'),
        api.get('/api/ihaleler/stats'),
        api.get('/api/ihaleler/queries'),
        api.get('/api/ihaleler/bookmarklet').catch(() => null),
      ]);
      setRows(r);
      setStats(s);
      setQueries(q);
      setBm(b);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function markRead(ikn) {
    try {
      await api.put(`/api/ihaleler/ikn/${encodeURIComponent(ikn)}/read`);
      setRows((prev) => prev.map((r) => (r.ikn === ikn ? { ...r, is_read: true } : r)));
      setStats((prev) => (prev ? { ...prev, unread: Math.max(0, prev.unread - 1) } : prev));
    } catch {
      /* satır vurgusu kalır; liste yenilenince düzelir */
    }
  }

  async function markAllRead() {
    await api.put('/api/ihaleler/read-all').catch(() => {});
    await load();
  }

  async function copyBookmarklet() {
    if (!bm) return;
    try {
      await navigator.clipboard.writeText(bm.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setMsg({ type: 'err', text: 'Kopyalanamadı — bağlantıyı elle seçip kopyalayın.' });
    }
  }

  async function addQuery(e) {
    e.preventDefault();
    const text = newQuery.trim();
    if (!text) return;
    try {
      await api.post('/api/ihaleler/queries', { name: text, search_text: text });
      setNewQuery('');
      setMsg({ type: 'ok', text: 'Sorgu eklendi — bookmarklet\'i yeniden kopyalayın ki yeni sorgu da taramaya girsin.' });
      await load();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    }
  }

  async function removeQuery(id) {
    try {
      await api.del(`/api/ihaleler/queries/${id}`);
      setMsg({ type: 'ok', text: 'Sorgu silindi — bookmarklet\'i yeniden kopyalayın.' });
      await load();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    }
  }

  if (error) {
    return (
      <div>
        <div className="page-head"><h1>İhale Kutusu</h1></div>
        <div className="error-banner">
          <span>Veriler yüklenemedi: {error}</span>
          <button className="btn btn-sm" onClick={load}>Tekrar Dene</button>
        </div>
      </div>
    );
  }

  if (!rows) {
    return (
      <div>
        <div className="page-head"><h1>İhale Kutusu</h1></div>
        <div className="card">
          <div className="empty"><span className="empty-ico"></span>{loading ? 'Yükleniyor…' : 'Veri bulunamadı.'}</div>
        </div>
      </div>
    );
  }

  const unread = Number(stats?.unread ?? 0);
  const isStale = Boolean(stats?.is_stale);
  const lastRun = stats?.last_run;

  const daysLeft = (iso) => {
    if (!iso) return null;
    const d = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
    return d;
  };

  const durumBadge = (r) => {
    const t = String(r.durum_aciklama || '');
    if (t.includes('İptal')) return <span className="badge badge-red">İptal</span>;
    if (t.includes('Katılıma Açık')) return <span className="badge badge-green">Açık</span>;
    return <span className="badge badge-gray">{t || '—'}</span>;
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>İhale Kutusu</h1>
          <p className="sub">EKAP ihale duyuruları — günlük tek tıkla tarama</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => window.open(bm?.ekap_url || 'https://ekapv2.kik.gov.tr/ekap/search', '_blank')}>
            EKAP Aramayı Aç ↗
          </button>
          <button className="btn" onClick={load} disabled={loading}>{loading ? 'Yenileniyor…' : '🔄 Yenile'}</button>
        </div>
      </div>

      {msg && (
        <div className={msg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {/* Kurulum kartı — bookmarklet ritüeli */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>EKAP Taraması — Kurulum</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          EKAP, otomatik erişimi (Turnstile doğrulaması) engellediği için tarama sizin tarayıcınızda tek tıkla yapılır:
        </p>
        <ol style={{ paddingLeft: 20, fontSize: 13 }}>
          <li>Aşağıdaki bağlantıyı tarayıcı <b>yer imleri çubuğuna</b> sürükleyin (veya "Kopyala" ile elle ekleyin).</li>
          <li><b>EKAP Aramayı Aç ↗</b> ile EKAP arama sayfasını açın.</li>
          <li>Yer imindeki <b>"PTYP İhale Hasadı"</b> bağlantısına bir kez tıklayın — sonuçlar kutuya akar.</li>
        </ol>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <a
            href={bm?.code || '#'}
            onClick={(e) => e.preventDefault()}
            title="Bu bağlantıyı yer imleri çubuğuna sürükleyin"
            style={{
              display: 'inline-block',
              padding: '8px 14px',
              border: '2px dashed var(--border, #cbd5e1)',
              borderRadius: 8,
              background: 'var(--accent-soft, #f1f5f9)',
              fontSize: 13,
              cursor: 'grab',
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            🔖 PTYP İhale Hasadı
          </a>
          <button className="btn btn-sm" onClick={copyBookmarklet}>{copied ? '✓ Kopyalandı' : 'Kopyala'}</button>
          <button
            className="btn btn-sm"
            title="Sızıntı halinde ingest token'ını yenileyin — bookmarklet'i yeniden kopyalamanız gerekir"
            onClick={async () => {
              if (!window.confirm('İngest token yenilenecek; eski bookmarklet geçersiz olur. Devam?')) return;
              try {
                await api.post('/api/ihaleler/ingest-token/regenerate');
                setMsg({ type: 'ok', text: 'Token yenilendi — bookmarklet\'i yeniden kopyalayın.' });
                await load();
              } catch (err) {
                setMsg({ type: 'err', text: err.message });
              }
            }}
          >
            Token Yenile
          </button>
          {bm?.token_suffix && <span className="muted" style={{ fontSize: 12 }}>token: {bm.token_suffix}</span>}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Sorguları değiştirince bookmarklet'i yeniden kopyalayın (yeni sorgular gömülü gelir).
        </p>
      </div>

      {/* Son tarama + sorgular */}
      <div className="grid-cards">
        <div className={`stat-card ${unread > 0 ? 'warn' : ''}`}>
          <div className="stat-value">{unread}</div>
          <div className="stat-label">Okunmamış İhale</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ fontSize: 18 }}>
            {lastRun
              ? `${lastRun.status === 'ok' ? '✓' : lastRun.status === 'error' ? '⚠' : '…'} ${fmtDate(lastRun.finished_at || lastRun.started_at)}`
              : 'Henüz tarama yok'}
          </div>
          <div className="stat-label">
            Son Tarama
            {lastRun?.status === 'ok' && lastRun.new_count > 0 ? ` · yeni ${lastRun.new_count}` : ''}
            {isStale && <span className="badge badge-amber" style={{ marginLeft: 8 }}>tarama uyuyor</span>}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ fontSize: 16 }}>
            {queries.map((q) => (
              <span
                key={q.id}
                className="badge badge-blue"
                style={{ marginRight: 4, cursor: 'pointer' }}
                title={`${q.search_text} — sil`}
                onClick={() => removeQuery(q.id)}
              >
                {q.search_text} ✕
              </span>
            ))}
          </div>
          <div className="stat-label">İzleme Sorguları</div>
        </div>
      </div>

      <form onSubmit={addQuery} style={{ display: 'flex', gap: 8, margin: '12px 0 16px', flexWrap: 'wrap' }}>
        <input
          placeholder="Yeni anahtar kelime (örn. trafo merkezi)"
          value={newQuery}
          onChange={(e) => setNewQuery(e.target.value)}
          style={{ flex: '1 1 260px' }}
        />
        <button className="btn" type="submit">+ Sorgu Ekle</button>
        {rows.length > 0 && unread > 0 && (
          <button type="button" className="btn btn-sm" onClick={markAllRead}>Tümünü Okundu İşaretle</button>
        )}
      </form>

      {rows.length === 0 ? (
        <div className="card">
          <div className="empty">
            <div>Henüz ihale yok — yukarıdaki kurulumu yapın ve EKAP'te yer imine bir kez tıklayın.</div>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>İKN</th>
                <th>İhale</th>
                <th>İdare</th>
                <th>İl</th>
                <th>Durum</th>
                <th style={{ width: 140 }}>İhale Tarihi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const dl = daysLeft(r.ihale_tarih_saat);
                return (
                  <tr
                    key={r.ikn}
                    style={{ cursor: 'pointer', fontWeight: r.is_read ? undefined : 600 }}
                    onClick={() => {
                      markRead(r.ikn);
                      window.open(bm?.ekap_url || 'https://ekapv2.kik.gov.tr/ekap/search', '_blank');
                    }}
                  >
                    <td>{r.ikn}</td>
                    <td>
                      {r.ihale_adi}
                      {Array.isArray(r.changed_fields) && r.changed_fields.length > 0 && (
                        <span className="badge badge-amber" style={{ marginLeft: 6 }}>değişti</span>
                      )}
                    </td>
                    <td className="muted">{r.idare_adi}</td>
                    <td className="muted">{r.il}</td>
                    <td>{durumBadge(r)}</td>
                    <td>
                      <div>{fmtDate(r.ihale_tarih_saat)}</div>
                      {dl !== null && (
                        <span className={`badge ${dl < 0 ? 'badge-red' : dl <= 7 ? 'badge-amber' : 'badge-gray'}`}>
                          {dl < 0 ? 'kapandı' : `${dl} gün`}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
