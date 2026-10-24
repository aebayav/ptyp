import { parseDtlLine, parsePdfTextDtl, normalizeCrossing, normalizeRemarks, parseDtlHeaderText } from '../src/dtl-parser';
import { normalizeTowerType } from '../src/tower-types';
import { parsePdfText, parseTm3Lines, wgs84ToTm3, tm3ToWgs84, utmToWgs84 } from '../src/coord-parser';
import { detectRegion } from '../src/turkiye-regions';
import { parsePriceToken } from '../src/quote-parser';

const lines = [
  '13 | 322,19 | 350 | 275 | 3+622 00 | T | 13 | PB1 | 28 | 12 | 0.00 | 10.50 | 2 | 2 | 2 | 2 | 853 47 | A | 13 | U120BL | 592182.73 | 4245808.12 | 1 | 2',
  '18 | 330.01 | 283 | 201 | 5+257.99 | S.4 | 234.4530 | KD | 18 | PF1 | 14 | 0 | 0.00 | 10.50 | 3 | 2 | 3 | 3 | 860.91 | CG/CG | 26/26 | U160BL | 592300.10 | 4245000.20',
  '120 | 43.66 | 82 | 14 | 42+435.93 | ND.2 | 187.1042 | N | 120 | PF1 | 16 | 3 | 0 00 | 10.50 | 2 | 2 | 2 | 2 | 783.09 | CG/G | 26/13 | U160BL | 597690.99 | 4230000.50',
  '117 | 250.46 | 225 | 424 | 41+820.65 | S.30 | 252.7377 | 154 kV E.L.H | KD | 117 | PFT | 40 | 27 | 0.00 | 10 50 | 2 | 2 | 2 | 2 | 802.94 | CG/CG | 26/26 | U160BL | 597000.00 | 4231000.00 | MIKROKAZIK | 2 | 1',
  'PORTAL | 45.20 | 0+000.00 | 253.9897 | 1084.50 | 592799.00 | 4249264.00',
  '1 | 214.00 | 135 | 383 | 0+000.00 | ND.1 | 253,9897 | TOPRAK YOL | N | 1 | PF1 | 20 | 6 | 0.00 | 11.50 | 2 | 6 | 4 | 3 | 1084.50 | CG/CG | 26/26 | U160BL | 592814.87 | 4249215.87',
  '5 | 300 | 0+500.00 | T | CPD | 13 | 2 | 0.00 | 1.00 | 1 | 1 | 1 | 1 | 900.00 | 13 | U70BL | 592259.15 | 4248266.57',
  '7 | 300 | 1+12345 | T | 7(N) | PD(S) | 16 | 3 | 0.00 | 1.00 | 1 | 1 | 1 | 1 | 900.00 | 13 | U70BL | 592259.15 | 4248266.57',
  'TOWER NO | SPAN',
];
for (const l of lines) console.log(JSON.stringify(parseDtlLine(l)));
for (const t of ['PFT', 'PBI', 'PF1', 'P81', 'PD5', 'XYZ', 'pf-1', 'PB1(S)', '2FN1', '2F51', 'PC', 'PE7', 'PORTAI', '', 'PA0', 'PB8'])
  console.log(t, '->', normalizeTowerType(t));
console.log(normalizeCrossing('DEMİRYOLU'), '|', normalizeCrossing('TOPRAK YOL | 34.5 kV E.I.H'), '|', normalizeCrossing('XYZ  abc'));
console.log(normalizeRemarks('TAKVİYE'), '|', normalizeRemarks('ÇEVİRME KONSOLLU KATODİK'));
console.log(JSON.stringify(parseDtlHeaderText('154 kV PHEASANT 1272 MCM\nLİCE TM - KULP HES E.İ.HATTI\nNOTLAR: 1. Bütün direkler\n2. ikinci not')));
console.log(JSON.stringify(parsePdfText('D-1 39,1234 32,5678\nD-2 39.1234 32.5678\n3 39.1234, 32.5678')));
console.log(JSON.stringify(parseTm3Lines('8 4247726.27 4249215.87\n9 6592814.87 4249215.87\n10 4249215.87 592814.87')));
const s = wgs84ToTm3(38.3, 36.0, 36); console.log(s);
console.log(tm3ToWgs84(s.easting, s.northing, 36));
console.log(utmToWgs84(500000, 4239000, 37));
console.log(JSON.stringify(detectRegion('LİCE TM')), JSON.stringify(detectRegion('unvan olmus')).slice(0, 200));
for (const p of ['1.234,56', '1,234.56', '1.234', '12.5', '1,234', '12,50', '₺ 1.850,50 TL', '0', 'abc', '100TL']) console.log(p, parsePriceToken(p));
