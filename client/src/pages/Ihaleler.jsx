import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtDate } from '../utils';

// İhale Kutusu — sunucu tarafı hasat (giriş yapılı EKAP oturum çereziyle).
// Ritüel: EKAP'e gir → çerezi bir kez kaydet → günlük timer + "Şimdi Tara".
export default function Ihaleler() {
  const [rows, setRows] = useState(null);
  const [stats, setStats] = useState(null);
  const [queries, setQueries] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newQuery, setNewQuery] = useState('');
  const [msg, setMsg] = useState(null);
  const [cookieInput, setCookieInput] = useState('');
  const [showCookieForm, setShowCookieForm] = useState(false);
  const [savingCookie, setSavingCookie] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    // Çerez yoksa kurulum formu açık başlar
    if (stats && !stats.has_cookies) setShowCookieForm(true);
  }, [stats?.has_cookies]);

  async function load() {
    try {
      setError(null);
      const [r, s, q] = await Promise.all([
        api.get('/api/ihaleler'),
        api.get('/api/ihaleler/stats'),
        api.get('/api/ihaleler/queries'),
      ]);
      setRows(r);
      setStats(s);
      setQueries(q);
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
      /* liste yenilenince düzelir */
    }
  }

  async function markAllRead() {
    await api.put('/api/ihaleler/read-all').catch(() => {});
    await load();
  }

  async function saveCookies(e) {
    e.preventDefault();
    const cookies = cookieInput.trim();
    if (!cookies) {
      setMsg({ type: 'err', text: 'Çerez alanı boş — EKAP sekmesinden cookie satırını kopyalayın.' });
      return;
    }
    setSavingCookie(true);
    try {
      await api.put('/api/ihaleler/ekap-cookies', { cookies });
      setCookieInput('');
      setMsg({ type: 'ok', text: 'Çerez kaydedildi — "Şimdi Tara" ile test edin.' });
      await load();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setSavingCookie(false);
    }
  }

  async function scanNow() {
    if (scanning) return;
    setScanning(true);
    setMsg(null);
    try {
      await api.post('/api/ihaleler/scan-now');
      // Tarama arka planda koşar (spawn) — stats'ı yoklayıp bitmesini bekle
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await api.get('/api/ihaleler/stats');
        const run = s.last_run;
        if (run && run.status !== 'running' && new Date(run.started_at).getTime() > Date.now() - 10 * 60 * 1000) {
          setStats(s);
          if (run.status === 'ok') {
            setMsg({ type: 'ok', text: `Tarama tamam: ${run.new_count} yeni, ${run.changed_count} değişen.` });
          } else {
            setMsg({ type: 'err', text: `Tarama başarısız: ${run.error || 'bilinmeyen hata'}` });
          }
          await load();
          break;
        }
      }
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setScanning(false);
    }
  }

  async function addQuery(e) {
    e.preventDefault();
    const text = newQuery.trim();
    if (!text) return;
    try {
      await api.post('/api/ihaleler/queries', { name: text, search_text: text });
      setNewQuery('');
      setMsg({ type: 'ok', text: 'Sorgu eklendi — bir sonraki taramada kullanılacak.' });
      await load();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    }
  }

  async function removeQuery(id) {
    try {
      await api.del(`/api/ihaleler/queries/${id}`);
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
  const hasCookies = Boolean(stats?.has_cookies);
  const lastRun = stats?.last_run;

  const daysLeft = (iso) => {
    if (!iso) return null;
    return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
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
          <p className="sub">EKAP ihale duyuruları — günlük otomatik tarama</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={scanNow} disabled={scanning}>
            {scanning ? 'Taranıyor…' : '🔍 Şimdi Tara'}
          </button>
          <button className="btn" onClick={load} disabled={loading}>{loading ? 'Yenileniyor…' : '🔄 Yenile'}</button>
        </div>
      </div>

      {msg && (
        <div className={msg.type === 'ok' ? 'notice-banner' : 'form-error'} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {/* Oturum kurulumu — çerez kayıtlıysa kapalı kalır, "Güncelle" ile açılır */}
      {showCookieForm ? (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--amber, #d97706)' }}>
          <h3 style={{ marginTop: 0 }}>EKAP Oturumu</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            EKAP, otomatik erişimi (Turnstile) engellediği için tarama <b>sizin giriş yapılı oturumunuzla</b> yapılır.
            Bir kez ayarlanır; çerez eskirse tarama hatası "oturumu yenile" der.
          </p>
          <ol style={{ paddingLeft: 20, fontSize: 13 }}>
            <li>Yeni sekmede <b>ekapv2.kik.gov.tr</b>'i açın ve <b>firma hesabınızla giriş yapın</b>.</li>
            <li>Sayfada <b>F12</b> → <b>Network</b> sekmesi → listede herhangi bir isteğe tıklayın.</li>
            <li><b>Request Headers</b> altındaki <b>cookie:</b> satırının <b>tamamını</b> kopyalayın (uzun bir satır).</li>
            <li>Aşağıya yapıştırıp kaydedin — ardından "Şimdi Tara" ile test edin.</li>
          </ol>
          <form onSubmit={saveCookies} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              placeholder="cookie: EKAP_SESSION=... (tam satır)"
              value={cookieInput}
              onChange={(e) => setCookieInput(e.target.value)}
              style={{ flex: '1 1 320px', fontFamily: 'monospace', fontSize: 12 }}
            />
            <button className="btn" type="submit" disabled={savingCookie}>
              {savingCookie ? 'Kaydediliyor…' : 'Çerezi Kaydet'}
            </button>
          </form>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="badge badge-green">✓ EKAP oturumu kayıtlı</span>
            <button
              className="btn btn-sm"
              onClick={() => setShowCookieForm(true)}
              title="Çerez eskidiğinde yeni oturum çerezini kaydedin"
            >
              Çerezi Güncelle
            </button>
          </div>
        </div>
      )}

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
            {lastRun?.status === 'error' && <span className="badge badge-red" style={{ marginLeft: 8 }}>hata</span>}
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
            <div>Henüz ihale yok — EKAP oturumunu kaydedin ve "Şimdi Tara"ya basın.</div>
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
                      window.open('https://ekapv2.kik.gov.tr/ekap/search', '_blank');
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
