// İhale İzleme çekirdeği — EKAP hasat satırlarını DB kayıtlarına haritalar,
// değişim sınıflar ve tarama politikasını (bayatlama/çakışma) karar verir.
// Tamamen saf: DB'siz birim test edilir (server/test/ihale-upsert.test.ts).

import crypto from 'crypto';

/** EKAP arama API'sinden gelen satır (canlı keşif şeması — 21.11.2026). */
export interface EkapRow {
  id: string;
  ikn: string;
  ihaleAdi: string;
  ihaleTip: string;
  ihaleTipAciklama: string;
  ihaleUsulAciklama: string;
  ihaleDurum: string;
  ihaleDurumAciklama: string;
  idareAdi: string;
  ihaleIlAdi: string;
  ihaleTarihSaat: string; // 'DD.MM.YYYY HH:mm' — Europe/Istanbul duvar saati
  dokumanSayisi: number;
}

/** mapEkapRow çıktısı — tenders tablosu sütunlarıyla birebir. */
export interface TenderMapped {
  ikn: string;
  ihale_adi: string;
  ihale_tip: string;
  usul: string;
  durum: string;
  durum_aciklama: string;
  idare_adi: string;
  il: string;
  ihale_tarih_saat: Date | null;
  content_hash: string;
}

/** classifyUpsert girdisi — tenders tablosundaki mevcut satır. */
export interface TenderExisting {
  ikn: string;
  ihale_adi: string;
  ihale_tip: string;
  usul: string;
  durum: string;
  durum_aciklama: string;
  idare_adi: string;
  il: string;
  ihale_tarih_saat: Date | null;
  content_hash: string;
}

export interface UpsertDecision {
  action: 'insert' | 'update_changed' | 'update_seen';
  changedFields: string[];
}

// Türkiye yaz saati uygulaması (Mart sonu → Ekim sonu +03, kalan yıl +04'ü
// düşünmez; EKAP ihaleleri gelecek tarihli ve yıl boyu +03'e yakın — DST 2027
// yaz dönemi de +03 olduğundan sabit +03 offseti yıl boyunca yeterli).
const TR_OFFSET_MS = 3 * 60 * 60 * 1000;

/** 'DD.MM.YYYY HH:mm' (Europe/Istanbul duvar saati) → Date (UTC anlık).
 *  Konak saat diliminden bağımsız: bileşenler +03 offsetiyle UTC'ye taşınır. */
export function parseEkapTarih(s: string): Date | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  // Sınır kontrolleri: 404 örneği ('32.13.2027 99:00') null dönsün
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59) return null;
  const utc = Date.UTC(yyyy, mm - 1, dd, hh, mi) - TR_OFFSET_MS;
  const d = new Date(utc);
  // Ayın günü geçerliliği (ör. 31.02) Date.UTC taşmasıyla yakalanır
  if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return d;
}

/** Anlamlı alanların karması — yalnız bunlar değişince "değişti" sayılır. */
function tenderContentHash(r: EkapRow): string {
  return crypto
    .createHash('sha256')
    .update([r.ihaleAdi, r.ihaleDurum, r.ihaleTarihSaat].join('/'))
    .digest('hex')
    .slice(0, 16);
}

export function mapEkapRow(raw: EkapRow): TenderMapped {
  return {
    ikn: String(raw.ikn || '').trim(),
    ihale_adi: String(raw.ihaleAdi || '').trim(),
    ihale_tip: String(raw.ihaleTip || '').trim(),
    usul: String(raw.ihaleUsulAciklama || '').trim(),
    durum: String(raw.ihaleDurum || '').trim(),
    durum_aciklama: String(raw.ihaleDurumAciklama || '').trim(),
    idare_adi: String(raw.idareAdi || '').trim(),
    il: String(raw.ihaleIlAdi || '').trim(),
    ihale_tarih_saat: parseEkapTarih(raw.ihaleTarihSaat),
    content_hash: tenderContentHash(raw),
  };
}

/** Yeni / değişti (anlamlı alan) / yalnız görüldü (rutin tazeleme) kararı. */
export function classifyUpsert(existing: TenderExisting | null, incoming: TenderMapped): UpsertDecision {
  if (!existing) return { action: 'insert', changedFields: [] };

  if (existing.content_hash === incoming.content_hash) {
    return { action: 'update_seen', changedFields: [] };
  }

  // Karma farklı: hangi anlamlı alanlar değişti? (changed_fields JSONB'ye yazılır)
  const changedFields: string[] = [];
  if (existing.ihale_adi !== incoming.ihale_adi) changedFields.push('ihale_adi');
  if (existing.durum !== incoming.durum) changedFields.push('durum');
  const exT = existing.ihale_tarih_saat ? new Date(existing.ihale_tarih_saat).getTime() : null;
  const inT = incoming.ihale_tarih_saat ? incoming.ihale_tarih_saat.getTime() : null;
  if (exT !== inT) changedFields.push('ihale_tarih_saat');
  return { action: 'update_changed', changedFields };
}

/** Son başarılı tarama 48 saatten eski mi? (Portföy bayatlama çipi) */
export function isScanStale(lastOkIso: string | null, nowMs: number = Date.now()): boolean {
  if (!lastOkIso) return true;
  const t = Date.parse(lastOkIso);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > 48 * 60 * 60 * 1000;
}

/** 'running' duran bir koşu bu kadar süredir başladıysa terk edilmiştir
 *  (çökme kalıntısı) — kilit açılıp hata olarak kapatılabilir. */
export const RUN_ABANDON_MS = 15 * 60 * 1000;

export function isRunAbandoned(startedIso: string, nowMs: number = Date.now()): boolean {
  const t = Date.parse(startedIso);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > RUN_ABANDON_MS;
}

/** Elle tarama izni: çalışıyor mu, çok yeni mi koşuldu mu? (çift tetikleme koruması) */
export function scanGuard(
  lastRun: { status: string; started_at: string } | null,
  nowMs: number = Date.now()
): { allow: boolean; reason?: string } {
  if (!lastRun) return { allow: true };
  const started = Date.parse(lastRun.started_at);
  const ageMs = Number.isFinite(started) ? nowMs - started : Infinity;
  if (lastRun.status === 'running') {
    return { allow: false, reason: 'Bir tarama hâlen çalışıyor. Lütfen bitmesini bekleyin.' };
  }
  // Hatalı koşudan sonra (örn. çerez yenilendi) 10 dk kilitleme — 10 sn sonra tekrar denenebilsin
  if (lastRun.status === 'error') {
    if (ageMs < 10 * 1000) {
      return { allow: false, reason: 'Lütfen birkaç saniye bekleyip tekrar deneyin.' };
    }
    return { allow: true };
  }
  if (ageMs < 10 * 60 * 1000) {
    return { allow: false, reason: 'Son tarama 10 dakikadan yeni. Lütfen bir süre sonra deneyin.' };
  }
  return { allow: true };
}
