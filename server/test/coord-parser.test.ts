import { describe, it, expect } from 'vitest';
import {
  parseCoordNumber,
  tm3ToWgs84,
  wgs84ToTm3,
  utmToWgs84,
  convertTm3List,
  parseTm3Lines,
  parseUtmLines,
  parsePdfText,
} from '../src/coord-parser';

// Gerçek Indra OCR çıktısı (ocr-service/bench_out/DTL_01.json → rows.indra[].raw)
const INDRA_RAW = [
  'PORTAL | 592799.00 | 4249264.00',
  '1 | 592814.87 | 4249215.87',
  '2 | 592706.76 | 4249031.19',
  '3 | 592573.38 | 4248803.35',
  '4 | 592407.68 | 4248520.29',
  '5 | 592259.15 | 4248266.57',
  '29 | 592820.08 | 4240241.41',
  '30 | 592955.46 | 4240024.14',
  '31 | 593054.00 | 4239866.00',
].join('\n');

/** Yaklaşık metre cinsinden iki enlem/boylam farkı */
function metersApart(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const dy = (a.lat - b.lat) * 111320;
  const dx = (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

describe('parseCoordNumber', () => {
  it('passes finite numbers through and rejects non-finite', () => {
    expect(parseCoordNumber(39.5)).toBe(39.5);
    expect(parseCoordNumber(0)).toBe(0);
    expect(parseCoordNumber(NaN)).toBeNull();
    expect(parseCoordNumber(Infinity)).toBeNull();
  });

  it('returns null for null/undefined/empty/whitespace', () => {
    expect(parseCoordNumber(null)).toBeNull();
    expect(parseCoordNumber(undefined)).toBeNull();
    expect(parseCoordNumber('')).toBeNull();
    expect(parseCoordNumber('   ')).toBeNull();
  });

  it('parses dot decimals', () => {
    expect(parseCoordNumber('39.1234')).toBe(39.1234);
    expect(parseCoordNumber(' 592814.87 ')).toBe(592814.87);
  });

  it('parses Turkish decimal comma', () => {
    expect(parseCoordNumber('39,1234')).toBe(39.1234);
    expect(parseCoordNumber('592259,15')).toBe(592259.15);
  });

  it('parses Turkish thousand-dot + decimal-comma', () => {
    expect(parseCoordNumber('1.234,56')).toBe(1234.56);
    expect(parseCoordNumber('4.249.215,87')).toBe(4249215.87);
  });

  it('rejects junk and ambiguous multi-separator strings', () => {
    expect(parseCoordNumber('abc')).toBeNull();
    expect(parseCoordNumber('12a')).toBeNull();
    expect(parseCoordNumber('1.234.567')).toBeNull(); // birden fazla nokta, virgül yok
    expect(parseCoordNumber('1,2,3')).toBeNull();
  });

  it('stringifies non-string input', () => {
    expect(parseCoordNumber({ toString: () => '41,5' })).toBe(41.5);
  });
});

describe('TM3 (ITRF-96 3°) forward/inverse', () => {
  it('a point on the central meridian has easting exactly 500000', () => {
    const { easting, northing } = wgs84ToTm3(38.3, 36.0, 36);
    expect(easting).toBeCloseTo(500000, 6);
    // ~38.3° enlem için meridyen yayı ≈ 4.24 Mm
    expect(northing).toBeGreaterThan(4_240_000);
    expect(northing).toBeLessThan(4_242_000);
  });

  it('easting increases east of CM and decreases west of CM', () => {
    expect(wgs84ToTm3(38.3, 36.5, 36).easting).toBeGreaterThan(500000);
    expect(wgs84ToTm3(38.3, 35.5, 36).easting).toBeLessThan(500000);
    // 0.5° ≈ 43.7 km @ 38.3°
    expect(wgs84ToTm3(38.3, 36.5, 36).easting - 500000).toBeGreaterThan(43_000);
    expect(wgs84ToTm3(38.3, 36.5, 36).easting - 500000).toBeLessThan(44_500);
  });

  // Türkiye'nin tüm 3° dilimleri; dilim içinde CM ±1.5° ve 36..42 enlem aralığı
  const CMS = [27, 30, 33, 36, 39, 42, 45];
  for (const cm of CMS) {
    it(`round-trips WGS84 → TM3 → WGS84 with sub-cm error (CM ${cm})`, () => {
      for (const lat of [36.2, 38.3, 40.1, 41.9]) {
        for (const dLon of [-1.5, -0.75, 0, 0.4, 1.5]) {
          const lon = cm + dLon;
          const tm = wgs84ToTm3(lat, lon, cm);
          const back = tm3ToWgs84(tm.easting, tm.northing, cm);
          expect(metersApart({ lat, lon }, back)).toBeLessThan(0.01);
        }
      }
    });
  }

  it('round-trips TM3 → WGS84 → TM3 for real OCR coordinates (CM 36)', () => {
    for (const { easting, northing } of parseTm3Lines(INDRA_RAW)) {
      const ll = tm3ToWgs84(easting, northing, 36);
      const back = wgs84ToTm3(ll.lat, ll.lon, 36);
      expect(Math.abs(back.easting - easting)).toBeLessThan(0.01);
      expect(Math.abs(back.northing - northing)).toBeLessThan(0.01);
    }
  });

  it('real DTL_01 fixture lands in south-east Türkiye on CM 39 (regression: footpoint series ~10 km bug)', () => {
    // cde74c7: eski ileri-seri katsayıları enlemi ~0.0937° güneye kaydırıyordu
    const ll = tm3ToWgs84(592814.87, 4249215.87, 39);
    expect(ll.lat).toBeGreaterThan(38.3);
    expect(ll.lat).toBeLessThan(38.45);
    expect(ll.lon).toBeGreaterThan(40.0);
    expect(ll.lon).toBeLessThan(40.1);
  });
});

describe('utmToWgs84', () => {
  it('uses zone CM = zone*6-183 and k0=0.9996', () => {
    // CM üzerindeki nokta: UTM northing = 0.9996 × TM3(k0=1) northing
    const lat = 38.3;
    const tm3 = wgs84ToTm3(lat, 39, 39);
    const ll = utmToWgs84(500000, tm3.northing * 0.9996, 37);
    expect(ll.lon).toBeCloseTo(39, 9);
    expect(ll.lat).toBeCloseTo(lat, 7);
  });

  it('zone 35..38 central meridians', () => {
    expect(utmToWgs84(500000, 4_400_000, 35).lon).toBeCloseTo(27, 9);
    expect(utmToWgs84(500000, 4_400_000, 36).lon).toBeCloseTo(33, 9);
    expect(utmToWgs84(500000, 4_400_000, 38).lon).toBeCloseTo(45, 9);
  });

  it('is consistent with an off-meridian TM point scaled by k0', () => {
    // UTM ve TM3 aynı CM'de (zone 37 = CM 39): koordinatlar k0 oranıyla ölçeklenir
    const lat = 37.9;
    const lon = 40.2;
    const tm = wgs84ToTm3(lat, lon, 39);
    const e = 500000 + (tm.easting - 500000) * 0.9996;
    const n = tm.northing * 0.9996;
    const ll = utmToWgs84(e, n, 37);
    expect(metersApart({ lat, lon }, ll)).toBeLessThan(0.01);
  });
});

describe('convertTm3List', () => {
  it('returns [] for empty input', () => {
    expect(convertTm3List([], 36)).toEqual([]);
  });

  it('converts rows and keeps names', () => {
    const rows = parseTm3Lines(INDRA_RAW);
    const pts = convertTm3List(rows, 39);
    expect(pts).toHaveLength(rows.length);
    expect(pts[1].name).toBe('1');
    expect(pts[0].alt).toBeNull();
  });

  it('auto-shifts CM for points that cross into the neighbouring 3° zone', () => {
    // CM 30 doğu ucu (E≈629k) + CM 33 batı ucu (E≈371k) — orta bölgede nokta yok
    const lat = 39.5;
    const a = wgs84ToTm3(lat, 31.45, 30); // CM 30, yüksek easting
    const b = wgs84ToTm3(lat, 31.55, 33); // CM 33, düşük easting
    expect(a.easting).toBeGreaterThan(580000);
    expect(b.easting).toBeLessThan(420000);
    const pts = convertTm3List(
      [
        { name: 'A1', ...a },
        { name: 'A2', ...a },
        { name: 'B1', ...b },
      ],
      30
    );
    expect(pts).toHaveLength(3);
    expect(pts[0].lon).toBeCloseTo(31.45, 6);
    expect(pts[2].lon).toBeCloseTo(31.55, 6); // CM 33 ile çözüldü
  });

  it('drops points that fall outside Türkiye after conversion', () => {
    const pts = convertTm3List([{ name: 'X', easting: 500000, northing: 3_000_000 }], 36);
    expect(pts).toEqual([]);
  });
});

describe('parseTm3Lines', () => {
  it('parses real Indra OCR pipe-separated lines with pole names', () => {
    const rows = parseTm3Lines(INDRA_RAW);
    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({ name: 'PORTAL', easting: 592799, northing: 4249264 });
    expect(rows[1]).toEqual({ name: '1', easting: 592814.87, northing: 4249215.87 });
    expect(rows[8]).toEqual({ name: '31', easting: 593054, northing: 4239866 });
  });

  it('supports Turkish decimal comma and space separators', () => {
    const rows = parseTm3Lines('D-5 592259,15 4248266,57');
    expect(rows).toEqual([{ name: 'D-5', easting: 592259.15, northing: 4248266.57 }]);
  });

  it('normalises pole token names (d.1, P 5 not a single token)', () => {
    expect(parseTm3Lines('d.1 592814.87 4249215.87')[0].name).toBe('D-1');
    expect(parseTm3Lines('DP3; 592814.87; 4249215.87')[0].name).toBe('DP-3');
  });

  it('leaves name empty when first word is not a pole token', () => {
    expect(parseTm3Lines('Koordinat 592814.87 4249215.87')[0].name).toBe('');
  });

  it('strips zone prefix from 7-digit easting (e.g. 6 592814 → 592814)', () => {
    const rows = parseTm3Lines('9 6592814.87 4249215.87');
    expect(rows).toHaveLength(1);
    expect(rows[0].easting).toBeCloseTo(592814.87, 6);
    expect(rows[0].northing).toBe(4249215.87);
  });

  it('accepts swapped order northing + easting', () => {
    expect(parseTm3Lines('10 4249215.87 592814.87')).toEqual([
      { name: '10', easting: 592814.87, northing: 4249215.87 },
    ]);
  });

  it('regression D-8/D-65: rejects double-northing misread (4247726 → 247726 easting)', () => {
    // 4ec903b: %1e6 kuralı 4247726.27 değerini makul bir easting'e çeviriyordu
    expect(parseTm3Lines('8 4247726.27 4249215.87')).toEqual([]);
  });

  it('rejects eastings outside 300k-700k and northings outside 3M-6M', () => {
    expect(parseTm3Lines('1 250000.00 4249215.87')).toEqual([]);
    expect(parseTm3Lines('1 750000.00 4249215.87')).toEqual([]);
    expect(parseTm3Lines('1 592814.87 2999999.00')).toEqual([]);
  });

  it('skips blank/irrelevant lines', () => {
    expect(parseTm3Lines('\n\n  \nDİREK NO | Y | X\n')).toEqual([]);
  });
});

describe('parseUtmLines', () => {
  it('parses 6+7 digit pairs with names', () => {
    const rows = parseUtmLines(INDRA_RAW);
    expect(rows).toHaveLength(9);
    expect(rows[5]).toEqual({ name: '5', easting: 592259.15, northing: 4248266.57 });
  });

  it('supports Turkish decimal comma', () => {
    expect(parseUtmLines('P12 592259,15 4248266,57')).toEqual([
      { name: 'P-12', easting: 592259.15, northing: 4248266.57 },
    ]);
  });

  it('has a wider easting range than TM3 (100k-900k)', () => {
    expect(parseUtmLines('1 250000.00 4249215.87')).toHaveLength(1);
    expect(parseTm3Lines('1 250000.00 4249215.87')).toHaveLength(0);
  });

  it('ignores lines without a valid pair', () => {
    expect(parseUtmLines('1 59281 4249215\nfoo bar')).toEqual([]);
  });
});

describe('parsePdfText', () => {
  it('extracts lat/lon pairs with dot decimals and names', () => {
    const { poles } = parsePdfText('D-2 39.1234 32.5678\n3 39.1234, 32.5678');
    expect(poles).toEqual([
      { name: 'D-2', lat: 39.1234, lon: 32.5678, alt: null },
      { name: '3', lat: 39.1234, lon: 32.5678, alt: null },
    ]);
  });

  it('swaps lon/lat order based on value ranges', () => {
    // 43.x yalnız boylam aralığında → çift ters sırada okunur
    const { poles } = parsePdfText('Direk 7: 43.1234 38.5678');
    expect(poles).toHaveLength(1);
    expect(poles[0].lat).toBe(38.5678);
    expect(poles[0].lon).toBe(43.1234);
  });

  it('skips lines whose pairs are outside Türkiye', () => {
    expect(parsePdfText('1 10.1234 12.5678\nheader line').poles).toEqual([]);
  });

  // BİLİNEN HATA: "39,1234 32,5678" (TR ondalık virgül) çifti pair.split(/[,;\s]+/)
  // ile 4 parçaya bölünüyor → satır düşüyor (coord-parser.ts ~L399).
  it.fails('BUG: should parse Turkish decimal comma lat/lon pairs', () => {
    expect(parsePdfText('D-1 39,1234 32,5678').poles).toHaveLength(1);
  });
});
