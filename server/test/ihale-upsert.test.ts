import { describe, it, expect } from 'vitest';
import { parseEkapTarih, mapEkapRow, classifyUpsert, isScanStale, scanGuard, EkapRow } from '../src/ihale-upsert';

// EKAP'tan gelen satır örneği (canlı keşifte yakalanan gerçek şema — 21.11.2026)
const RAW: EkapRow = {
  id: 'c75e3214709688b02eee453a6b682ba7b492d23c4e498e850191c566163ae711',
  ikn: '2026/271215',
  ihaleAdi: '63 kV Trafo Merkezi Yapım İşi',
  ihaleTip: '2',
  ihaleTipAciklama: 'Yapım',
  ihaleUsulAciklama: 'İhale Usulü: Açık',
  ihaleDurum: '2',
  ihaleDurumAciklama: 'İhale İlanı Yayımlanmış, Katılıma Açık',
  idareAdi: 'TEİAŞ GENEL MÜDÜRLÜĞÜ',
  ihaleIlAdi: 'DİYARBAKIR',
  ihaleTarihSaat: '23.03.2027 14:00',
  dokumanSayisi: 0,
};

describe('parseEkapTarih', () => {
  it('parses DD.MM.YYYY HH:mm as Europe/Istanbul wall time (UTC+3) regardless of host TZ', () => {
    expect(parseEkapTarih('23.03.2027 14:00')?.getTime()).toBe(Date.parse('2027-03-23T11:00:00Z'));
  });
  it('parses a second sample and rejects invalid input', () => {
    expect(parseEkapTarih('05.01.2027 09:30')?.getTime()).toBe(Date.parse('2027-01-05T06:30:00Z'));
    expect(parseEkapTarih('')).toBeNull();
    expect(parseEkapTarih('geçersiz')).toBeNull();
    expect(parseEkapTarih('32.13.2027 99:00')).toBeNull();
  });
});

describe('mapEkapRow', () => {
  it('maps all fields and produces a deterministic content_hash', () => {
    const m1 = mapEkapRow(RAW);
    const m2 = mapEkapRow(RAW);
    expect(m1.ikn).toBe('2026/271215');
    expect(m1.ihale_adi).toBe('63 kV Trafo Merkezi Yapım İşi');
    expect(m1.ihale_tip).toBe('2');
    expect(m1.usul).toBe('İhale Usulü: Açık');
    expect(m1.durum).toBe('2');
    expect(m1.durum_aciklama).toBe('İhale İlanı Yayımlanmış, Katılıma Açık');
    expect(m1.idare_adi).toBe('TEİAŞ GENEL MÜDÜRLÜĞÜ');
    expect(m1.il).toBe('DİYARBAKIR');
    expect(m1.ihale_tarih_saat?.getTime()).toBe(Date.parse('2027-03-23T11:00:00Z'));
    expect(m1.content_hash).toBe(m2.content_hash);
    expect(m1.content_hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('classifyUpsert', () => {
  const existing = (over: Record<string, unknown> = {}) => ({
    ikn: RAW.ikn,
    ihale_adi: RAW.ihaleAdi,
    ihale_tip: RAW.ihaleTip,
    usul: RAW.ihaleUsulAciklama,
    durum: RAW.ihaleDurum,
    durum_aciklama: RAW.ihaleDurumAciklama,
    idare_adi: RAW.idareAdi,
    il: RAW.ihaleIlAdi,
    ihale_tarih_saat: new Date('2027-03-23T11:00:00Z'),
    content_hash: mapEkapRow(RAW).content_hash,
    ...over,
  });

  it('returns insert for unseen İKN', () => {
    const r = classifyUpsert(null, mapEkapRow(RAW));
    expect(r.action).toBe('insert');
    expect(r.changedFields).toEqual([]);
  });

  it('re-flags as changed when the tender date shifts (erteleme)', () => {
    const r = classifyUpsert(existing(), mapEkapRow({ ...RAW, ihaleTarihSaat: '30.04.2027 14:00' }));
    expect(r.action).toBe('update_changed');
    expect(r.changedFields).toEqual(['ihale_tarih_saat']);
  });

  it('re-flags as changed when durum changes (iptal/düzeltme)', () => {
    const r = classifyUpsert(
      existing(),
      mapEkapRow({ ...RAW, ihaleDurum: '6', ihaleDurumAciklama: 'İhale İptal Edilmiş' })
    );
    expect(r.action).toBe('update_changed');
    expect(r.changedFields).toEqual(['durum']);
  });

  it('does NOT re-flag when only raw/noise fields differ (routine refresh)', () => {
    // dokumanSayisi ve id (hash) değişti ama anlamlı alanlar aynı
    const r = classifyUpsert(existing(), mapEkapRow({ ...RAW, dokumanSayisi: 3, id: 'ffffff' }));
    expect(r.action).toBe('update_seen');
    expect(r.changedFields).toEqual([]);
  });
});

describe('isScanStale', () => {
  it('flags staleness only beyond 48 hours of last successful scan', () => {
    const now = Date.parse('2026-11-21T12:00:00Z');
    expect(isScanStale('2026-11-21T10:00:00Z', now)).toBe(false); // 2 saat önce
    expect(isScanStale('2026-11-19T10:00:00Z', now)).toBe(true); // 50 saat önce
    expect(isScanStale(null, now)).toBe(true); // hiç tarama yok
  });
});

describe('scanGuard', () => {
  it('rejects while a scan is running', () => {
    const now = Date.parse('2026-11-21T12:00:00Z');
    const r = scanGuard({ status: 'running', started_at: '2026-11-21T11:59:00Z' }, now);
    expect(r.allow).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('rejects a scan started less than 10 minutes ago, allows after', () => {
    const now = Date.parse('2026-11-21T12:00:00Z');
    expect(scanGuard({ status: 'ok', started_at: '2026-11-21T11:55:01Z' }, now).allow).toBe(false); // ~5 dk
    expect(scanGuard({ status: 'ok', started_at: '2026-11-21T11:45:00Z' }, now).allow).toBe(true); // 15 dk
    expect(scanGuard(null, now).allow).toBe(true); // hiç koşu yok
  });
});
