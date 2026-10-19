// TEİAŞ / TEDAŞ Direk Tevzi Listesi (DTL) tam sütun ayrıştırıcı (Excel, Metin PDF ve OCR çıktısı)
import * as XLSX from 'xlsx';

export interface DtlHeader {
  title: string;
  voltage_kv: string;
  conductor: string;
  line_name: string;
  notes: string;
}

export interface DtlRow {
  pole: string;
  span_m: number | null;
  wind_span_m: number | null;
  weight_span_m: number | null;
  station_text: string;
  station_m: number | null;
  some_no: string;
  line_angle_grad: number | null;
  crossing: string;
  function: string;
  tower_type: string;
  nominal_height_m: number | null;
  body_ext_m: number | null;
  hook_diff_m: number | null;
  center_ext_m: number | null;
  leg_a_m: number | null;
  leg_b_m: number | null;
  leg_c_m: number | null;
  leg_d_m: number | null;
  ground_elev_m: number | null;
  insulator_set: string;
  insulator_count: string;
  insulator_ref: string;
  easting: number | null;
  northing: number | null;
  remarks: string;
  profile_no: number | null;
  ice_zone: number | null;
}

export interface DtlParseResult {
  header: DtlHeader;
  rows: DtlRow[];
}

const COORD_RE = /\b\d{6,7}(?:[.,]\d{1,4})?\b/g;
const HEADER_PAT =
  /(?:TOWER\s+NO|WIND\s+SPAN|WEIGHT\s+SPAN|INSULATOR|ARA\s+MESAFE|FONKS.YON|Tek\s+Ask|direklerin\s+ara|\(1\)\s*\(2\)|MAX\s+TOWER|S\.I\.NO\.)/i;

const CENTER_RE =
  /(?:(?<func>\b(?:KD|KT|N|D|T|A|B|C)\b)\s+)?(?:(?<pole2>\d{1,3}(?:\s*\([A-Z0-9]+\))?)\s+)?(?<ttype>\b(?:C?P[A-F]\d?(?:\([A-Z0-9]+\))?|2F[SN]\d|[1-4][A-Z]\d?|(?:K|G|T|D|N|PB|PA|PC|PD|PE|PF)[-./]?\d{1,3})\b)\s+(?<height>\d{1,2}(?:\.\d)?)\s+(?<body_ext>[+-]?\d{1,2})\b/i;

export function normalizeCrossing(raw: string): string {
  const s = (raw || '').replace(/[|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const u = s.toUpperCase();
  const items: string[] = [];
  if (u.includes('ASFALT') || u.includes('YOL') || u.includes('ŞOSE') || u.includes('SOSE')) {
    items.push('ASFALT YOL');
  }
  if (u.includes('P.T.T') || u.includes('PTT') || u.includes('TELEFON') || u.includes('TÜRK TELEKOM')) {
    items.push('P.T.T.');
  }
  if (
    u.includes('34.5') ||
    u.includes('34,5') ||
    u.includes('E.İ.H') ||
    u.includes('E.I.H') ||
    u.includes('E.LH') ||
    u.includes('E I H') ||
    u.includes('E L H')
  ) {
    items.push('34.5 kV E.İ.HATTI');
  }
  if (u.includes('O.G') || u.includes('O G') || /\bOG\b/.test(u)) {
    items.push('O.G.HATTI');
  }
  if (u.includes('A.G') || /\bAG\b/.test(u)) {
    items.push('A.G.HATTI');
  }
  if ((u.includes('DO') && u.includes('GAZ')) || u.includes('BORU HATTI')) {
    items.push('DOĞALGAZ');
  }
  if (u.includes('DEMİRYOLU') || u.includes('DEMIRYOLU') || u.includes('TCDD')) {
    items.push('DEMİRYOLU');
  }
  if (u.includes('DERE') || u.includes('NEHİR') || u.includes('ÇAY')) {
    items.push('DERE / AKARSU');
  }
  return items.length > 0 ? items.join(', ') : s;
}

export function normalizeRemarks(raw: string): string {
  const s = (raw || '').replace(/[|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const u = s.toUpperCase();
  const items: string[] = [];
  if (u.includes('ZEL') || u.includes('ASK') || u.includes('ASL') || u.includes('TAK') || u.includes('TOK')) {
    items.push('Özel Askı Takımı');
  }
  if (u.includes('KATOD')) {
    items.push('KATODİK KORUMA');
  }
  if (u.includes('EV') && u.includes('KONSOL')) {
    items.push('ÇEVİRME KONSOLLU');
  }
  if (u.includes('MIKROKAZ') || u.includes('MİKROKAZ')) {
    items.push('Mikrokazık Temelli');
  }
  return items.length > 0 ? items.join(', ') : s;
}

export function parseDtlHeaderText(text: string): DtlHeader {
  const raw = (text || '').replace(/\r/g, '\n');
  const vMatch = raw.match(/\b(380|154|66|34[.,]5|33|31[.,]5|15[.,]8)\s*kV\b/i);
  const voltage_kv = vMatch ? vMatch[1].replace(',', '.') + ' kV' : '';

  const cMatch = raw.match(
    /\b(\d{3,4}\s*MCM|\d\/\d\s*AWG|(?:CARDINAL|PHEASANT|HAWK|DRAKE|PARTRIDGE|RAVEN|SWALLOW|PIGEON)(?:\s*\d+\s*MCM)?)\b/i
  );
  const conductor = cMatch ? cMatch[1].replace(/\s+/g, ' ').toUpperCase() : '';

  let line_name = '';
  for (const l of raw.split('\n')) {
    const clean = l.trim();
    if (!clean) continue;
    if (/(?:TM|GES|RES|HES|OSB|HATTI|E\.İ\.H|E\.I\.H|E\.\s*[İI]\.\s*HATTI)/i.test(clean)) {
      line_name = clean
        .replace(/C35\s+POLU/i, 'G25 BOLU')
        .replace(/OSD\s+TM/i, 'OSB TM')
        .replace(/E\s+L\s+HATTI/i, 'E.İ.HATTI')
        .replace(/E\.\?\.HATTI/i, 'E.İ.HATTI');
      break;
    }
  }

  let notes = '';
  const nMatch = raw.match(/NOTLAR\s*:?\s*([^\n]+(?:\n[^\n]+)?)/i);
  if (nMatch) {
    notes = nMatch[1].replace(/\s+/g, ' ').trim();
  }

  const titleParts = [voltage_kv, conductor, line_name].filter(Boolean);
  return {
    title: titleParts.join(' — ') || line_name,
    voltage_kv,
    conductor,
    line_name,
    notes,
  };
}

export function parseDtlLine(line: string): DtlRow | null {
  if (!line || HEADER_PAT.test(line)) return null;
  let s = line.replace(/,/g, '.').replace(/[|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  // Silik ondalık / kilometraj noktalarını onar
  s = s.replace(/\b(\d{1,3})\s*[*+-]\s*(\d{3})[., ](\d{2})\b/g, '$1+$2.$3');
  s = s.replace(/\b(\d{1,3}\+\d{3})(\d{2})\b/g, '$1.$2');
  s = s.replace(/\b(\d{1,3}\+\d{3})\s+(\d{2})\b/g, '$1.$2');
  s = s.replace(/\b(\d{6,7})\s+(\d{2})\b/g, '$1.$2');
  s = s.replace(/\b([12]\d{3})\s+(\d{2})\b/g, '$1.$2');
  s = s.replace(/^(\s*(?:PORTAL\.?|\d{1,3}(?:\([A-Z0-9]+\))?)\s+\d{2,3})\s+(\d{2})\b/i, '$1.$2');
  s = s.replace(/\b(8|9|10|11|12|13)\s+(\d0)\b/g, '$1.$2');
  s = s.replace(/([+-]0)\s+(\d0)\b/g, '$1.$2');

  if (/^PORTAL\b/i.test(s)) {
    const coordsAll = s.match(COORD_RE) || [];
    const eastingP = coordsAll.length >= 2 ? parseFloat(coordsAll[coordsAll.length - 2]) : null;
    const northingP = coordsAll.length >= 2 ? parseFloat(coordsAll[coordsAll.length - 1]) : null;
    let sNoCoord = s.replace(COORD_RE, ' ');
    let stTextP = '';
    let stMP: number | null = null;
    const mStP = sNoCoord.match(/\b(\d{1,3})\+(\d{3}(?:\.\d{1,2})?)\b/);
    if (mStP && mStP.index !== undefined) {
      stTextP = mStP[0];
      stMP = Math.round((parseFloat(mStP[1]) * 1000 + parseFloat(mStP[2])) * 100) / 100;
      sNoCoord = sNoCoord.slice(0, mStP.index) + ' ' + sNoCoord.slice(mStP.index + mStP[0].length);
    }
    const nums = sNoCoord.match(/\b\d+(?:\.\d+)?\b/g) || [];
    let span_m: number | null = null;
    let angle: number | null = null;
    let elev: number | null = null;
    for (const n of nums) {
      const v = parseFloat(n);
      if (n.includes('.') && n.split('.')[1].length >= 3 && v >= 50 && v <= 400) {
        angle = v;
      } else if (v >= 500) {
        elev = v;
      } else if (v >= 5 && v < 500 && span_m === null) {
        span_m = v;
      }
    }
    return {
      pole: 'PORTAL',
      span_m,
      wind_span_m: null,
      weight_span_m: null,
      station_text: stTextP,
      station_m: stMP,
      some_no: '',
      line_angle_grad: angle,
      crossing: '',
      function: 'PORTAL',
      tower_type: 'PORTAL',
      nominal_height_m: null,
      body_ext_m: null,
      hook_diff_m: null,
      center_ext_m: null,
      leg_a_m: null,
      leg_b_m: null,
      leg_c_m: null,
      leg_d_m: null,
      ground_elev_m: elev,
      insulator_set: '',
      insulator_count: '',
      insulator_ref: '',
      easting: eastingP,
      northing: northingP,
      remarks: '',
      profile_no: null,
      ice_zone: null,
    };
  }

  const m = CENTER_RE.exec(s);
  if (!m || !m.groups) return null;

  const left = s.slice(0, m.index).trim();
  const right = s.slice(m.index + m[0].length).trim();

  let func = (m.groups.func || '').toUpperCase();
  const pole2 = (m.groups.pole2 || '').trim();
  const ttype = m.groups.ttype.toUpperCase().replace('2FN1', '2FS1');
  const height = parseFloat(m.groups.height);
  let body_ext = parseFloat(m.groups.body_ext);

  let pole = '';
  let leftRest = left;
  const mP1 = left.match(/^(\d{1,3}(?:\([A-Z0-9]+\))?)\s+(.*)/i);
  if (mP1) {
    pole = mP1[1];
    leftRest = mP1[2];
  } else {
    pole = pole2;
  }
  pole = pole.replace(/\(N\)/gi, '(S)');
  if (!func && pole.includes('(S)')) func = 'N';

  let station_text = '';
  let station_m: number | null = null;
  let beforeSt = leftRest;
  let afterSt = '';
  const mSt = leftRest.match(/\b(\d{1,3})\+(\d{3}(?:\.\d{1,2})?)\b/);
  if (mSt && mSt.index !== undefined) {
    station_text = mSt[0];
    station_m = Math.round((parseFloat(mSt[1]) * 1000 + parseFloat(mSt[2])) * 100) / 100;
    beforeSt = leftRest.slice(0, mSt.index).trim();
    afterSt = leftRest.slice(mSt.index + mSt[0].length).trim();
  }

  const bNums = (beforeSt.match(/\b\d+(?:\.\d+)?\b/g) || []).map(parseFloat);
  const span_m = bNums.length >= 1 ? bNums[0] : null;
  const wind_span_m = bNums.length >= 2 ? bNums[1] : null;
  const weight_span_m = bNums.length >= 3 ? bNums[2] : null;

  let some_no = '';
  const mSome = afterSt.match(/\b(ND\.[12]|[S8]\.\d{1,2}|S\.I)\b/i);
  if (mSome && mSome.index !== undefined) {
    some_no = mSome[1].toUpperCase().replace('S.I', 'S.1');
    if (some_no.startsWith('8.')) some_no = 'S.' + some_no.slice(2);
    afterSt = (afterSt.slice(0, mSome.index) + ' ' + afterSt.slice(mSome.index + mSome[0].length)).trim();
  }

  let line_angle_grad: number | null = null;
  const mAng = afterSt.match(/\b(\d{2,3}\.\d{3,4})\b/);
  if (mAng && mAng.index !== undefined) {
    line_angle_grad = parseFloat(mAng[1]);
    afterSt = (afterSt.slice(0, mAng.index) + ' ' + afterSt.slice(mAng.index + mAng[0].length)).trim();
  }

  const crossing = normalizeCrossing(afterSt);

  const rightCoords = right.match(COORD_RE) || [];
  const easting = rightCoords.length >= 2 ? parseFloat(rightCoords[rightCoords.length - 2]) : null;
  const northing = rightCoords.length >= 2 ? parseFloat(rightCoords[rightCoords.length - 1]) : null;

  let midRight = right;
  let tailRight = '';
  if (rightCoords.length >= 2) {
    const c1 = rightCoords[rightCoords.length - 2];
    const c2 = rightCoords[rightCoords.length - 1];
    const cIdx = right.indexOf(c1);
    const c2Idx = right.lastIndexOf(c2);
    midRight = right.slice(0, cIdx).trim();
    tailRight = right.slice(c2Idx + c2.length).trim();
  }

  let insulator_ref = '';
  const mIref = midRight.match(/\b(U\d{2,3}[A-Z]{1,3})\b/i);
  if (mIref && mIref.index !== undefined) {
    insulator_ref = mIref[1].toUpperCase();
    midRight = midRight.slice(0, mIref.index).trim();
  }

  let insulator_count = '';
  const mIcnt = midRight.match(/\b(\d{1,2}(?:\/\d{1,2})?)\s*$/);
  if (mIcnt && mIcnt.index !== undefined) {
    insulator_count = mIcnt[1];
    midRight = midRight.slice(0, mIcnt.index).trim();
  }

  let ground_elev_m: number | null = null;
  let extPart = midRight;
  const elevMatches = [...midRight.matchAll(/\b(\d{3,4}\.\d{1,2})\b/g)];
  if (elevMatches.length > 0) {
    const lastElev = elevMatches[elevMatches.length - 1];
    ground_elev_m = parseFloat(lastElev[1]);
    extPart = midRight.slice(0, lastElev.index).trim();
  }

  let insulator_set = '';
  if (insulator_count === '13') {
    insulator_set = 'A';
  } else if (insulator_count === '13/13') {
    insulator_set = 'ÇA';
  } else if (insulator_count.includes('/')) {
    insulator_set = 'ÇGÇG';
  } else {
    insulator_set = func === 'T' ? 'A' : 'ÇGÇG';
  }

  const extNums = (extPart.match(/[+-]?\d+(?:\.\d+)?/g) || []).map(parseFloat);
  const hook_diff_m = extNums.length >= 1 ? extNums[0] : null;
  const center_ext_m = extNums.length >= 2 ? extNums[1] : null;
  const legs = extNums.slice(2, 6).map((x) => Math.trunc(x));
  while (legs.length < 4) {
    legs.push(legs.length > 0 ? legs[legs.length - 1] : 0);
  }

  const tailNums = tailRight.match(/\b\d\b/g) || [];
  const profile_no = tailNums.length >= 2 ? parseInt(tailNums[tailNums.length - 2], 10) : null;
  const ice_zone = tailNums.length >= 2 ? parseInt(tailNums[tailNums.length - 1], 10) : null;
  const remarksRaw = tailRight.replace(/(?:^|\s+)\d(?:\s+\d)?\s*$/, '').trim();
  const remarks = normalizeRemarks(remarksRaw);

  if (!func) {
    func = insulator_set === 'A' || insulator_set === 'ÇA' ? 'T' : 'KD';
  }

  const h0Default = /^P[DEF]/.test(ttype) ? 13.0 : 16.0;
  if (body_ext !== 0 && Number.isFinite(height)) {
    const ab = Math.abs(body_ext);
    body_ext = Math.abs(height - ab - h0Default) < Math.abs(height + ab - h0Default) ? ab : -ab;
  }

  return {
    pole,
    span_m,
    wind_span_m,
    weight_span_m,
    station_text,
    station_m,
    some_no,
    line_angle_grad,
    crossing,
    function: func,
    tower_type: ttype,
    nominal_height_m: height,
    body_ext_m: body_ext,
    hook_diff_m,
    center_ext_m,
    leg_a_m: legs[0],
    leg_b_m: legs[1],
    leg_c_m: legs[2],
    leg_d_m: legs[3],
    ground_elev_m,
    insulator_set,
    insulator_count,
    insulator_ref,
    easting,
    northing,
    remarks,
    profile_no,
    ice_zone,
  };
}

function formatStationText(stationM: number): string {
  const km = Math.floor(stationM / 1000);
  const rem = Math.max(0, stationM - km * 1000);
  const [intPart, decPart] = rem.toFixed(2).split('.');
  return `${km}+${intPart.padStart(3, '0')}.${decPart}`;
}

export function finalizeDtlRows(rows: DtlRow[]): DtlRow[] {
  if (rows.length === 0) return [];
  const out = rows.map((r) => ({ ...r }));

  // 1. PORTAL dışındaki direklerin ardışık numara kontrolü
  const towerIndices: number[] = [];
  const offsets: (number | null)[] = [];
  out.forEach((r, idx) => {
    if (r.pole === 'PORTAL' || r.tower_type === 'PORTAL') return;
    const tIdx = towerIndices.length;
    towerIndices.push(idx);
    const m = r.pole.match(/^(\d{1,3})/);
    offsets.push(m ? parseInt(m[1], 10) - tIdx : null);
  });

  let bestAnchor: number | null = null;
  let bestRun = 0;
  let curAnchor: number | null = null;
  let curRun = 0;
  for (const o of [...offsets, null]) {
    if (o !== null && o === curAnchor) {
      curRun++;
    } else {
      if (curAnchor !== null && curRun > bestRun) {
        bestAnchor = curAnchor;
        bestRun = curRun;
      }
      curAnchor = o;
      curRun = o !== null ? 1 : 0;
    }
  }
  if (bestAnchor !== null && bestRun >= 3) {
    towerIndices.forEach((rowIdx, tIdx) => {
      const r = out[rowIdx];
      const suffixMatch = r.pole.match(/(\([A-Z0-9]+\))$/i);
      const suffix = suffixMatch ? suffixMatch[1].toUpperCase() : '';
      r.pole = `${bestAnchor! + tIdx}${suffix}`;
    });
  }

  // 2. İstasyon (station_m) ve ara mesafe (span_m) çapraz doğrulaması:
  //    station_m[i+1] = station_m[i] + span_m[i]
  for (let i = 0; i < towerIndices.length - 1; i++) {
    const cur = out[towerIndices[i]];
    const nxt = out[towerIndices[i + 1]];
    if (cur.station_m !== null && nxt.station_m !== null && cur.span_m !== null) {
      const expectedNext = Math.round((cur.station_m + cur.span_m) * 100) / 100;
      const diff = Math.abs(nxt.station_m - expectedNext);
      if (diff > 1.0) {
        // Eğer bir sonraki satır (i+2) ile nxt.station_m tutarlı ama cur.station_m 1000m hatalıysa (ör. 25+106 yerine 23+106)
        const fixedCurSt = Math.round((nxt.station_m - cur.span_m) * 100) / 100;
        if (fixedCurSt >= 0 && Math.abs(fixedCurSt - cur.station_m) >= 900) {
          cur.station_m = fixedCurSt;
          cur.station_text = formatStationText(fixedCurSt);
        } else if (nxt.station_m > cur.station_m && nxt.station_m - cur.station_m < 1200) {
          // İstasyonlar doğru ama ara mesafe rakamında tek hane OCR sapması varsa (ör. 290 vs 230)
          cur.span_m = Math.round((nxt.station_m - cur.station_m) * 100) / 100;
        }
      }
    }
  }

  return out;
}

export function parsePdfTextDtl(text: string): DtlParseResult {
  const header = parseDtlHeaderText(text);
  const rows: DtlRow[] = [];
  for (const line of (text || '').split(/\r?\n/)) {
    const parsed = parseDtlLine(line);
    if (parsed) rows.push(parsed);
  }
  return { header, rows: finalizeDtlRows(rows) };
}

function toNum(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '.').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseExcelDtl(buffer: Buffer): DtlParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const allTextLines: string[] = [];
  const structuredRows: DtlRow[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const grid = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: '' });
    if (!grid || grid.length === 0) continue;

    // Başlık tespiti: sütun adlarından indeks eşleştirme
    let headerRowIdx = -1;
    const colMap: Record<string, number> = {};

    for (let r = 0; r < Math.min(grid.length, 25); r++) {
      const row = grid[r].map((c: any) => String(c ?? '').trim());
      allTextLines.push(row.filter(Boolean).join(' '));
      const joined = row.join(' ').toUpperCase();
      if (
        (joined.includes('DİREK') || joined.includes('DIREK') || joined.includes('TOWER')) &&
        (joined.includes('MESAFE') || joined.includes('SPAN') || joined.includes('TİP') || joined.includes('KOORD'))
      ) {
        headerRowIdx = r;
        row.forEach((cell, cIdx) => {
          const u = cell.toUpperCase();
          if ((u.includes('DİREK NO') || u.includes('DIREK NO') || u.includes('TOWER NO')) && colMap.pole === undefined)
            colMap.pole = cIdx;
          else if (u.includes('ARA MESAFE') || /^SPAN\b/.test(u)) colMap.span_m = cIdx;
          else if (u.includes('RÜZGAR') || u.includes('RUZGAR') || u.includes('WIND')) colMap.wind_span_m = cIdx;
          else if (u.includes('AĞIRLIK') || u.includes('AGIRLIK') || u.includes('WEIGHT')) colMap.weight_span_m = cIdx;
          else if (u.includes('BALKON') || u.includes('STATION') || u.includes('KİLOMETRAJ')) colMap.station = cIdx;
          else if (u.includes('SOME')) colMap.some_no = cIdx;
          else if (u.includes('HAT AÇISI') || u.includes('HAT ACISI') || u.includes('ANGLE')) colMap.angle = cIdx;
          else if (u.includes('GEÇİLEN') || u.includes('GECILEN') || u.includes('CROSSING')) colMap.crossing = cIdx;
          else if (u.includes('FONKSİYON') || u.includes('FONKSIYON') || u.includes('FUNCTION')) colMap.func = cIdx;
          else if (u.includes('DİREK TİP') || u.includes('DIREK TIP') || u.includes('TOWER TYPE')) colMap.ttype = cIdx;
          else if (u.includes('TRAVERS') || u.includes('HEIGHT')) colMap.height = cIdx;
          else if (u.includes('GÖVDE') || u.includes('GOVDE') || u.includes('BODY EXT')) colMap.body_ext = cIdx;
          else if (u.includes('KANCA')) colMap.hook_diff = cIdx;
          else if (u.includes('MERKEZ KOT') || u.includes('CENTER EXT')) colMap.center_ext = cIdx;
          else if (u.includes('AYAK') && u.includes('A')) colMap.leg_a = cIdx;
          else if (u.includes('AYAK') && u.includes('B')) colMap.leg_b = cIdx;
          else if (u.includes('AYAK') && u.includes('C')) colMap.leg_c = cIdx;
          else if (u.includes('AYAK') && u.includes('D')) colMap.leg_d = cIdx;
          else if (u.includes('GÖBEK KOTU') || u.includes('GOBEK KOTU') || u.includes('ELEVATION')) colMap.elev = cIdx;
          else if (u.includes('ZİNCİR TERTİBAT') || u.includes('STRING SET')) colMap.ins_set = cIdx;
          else if (u.includes('İZOLATÖR ADED') || u.includes('NUMBER OF INSULATOR')) colMap.ins_count = cIdx;
          else if (u.includes('REFERANS') || u.includes('ÖZELLİĞİ') || u.includes('INSULATOR TYPE')) colMap.ins_ref = cIdx;
          else if ((u.includes('(Y)') || u.includes('SAĞA') || u.includes('EASTING')) && colMap.easting === undefined)
            colMap.easting = cIdx;
          else if ((u.includes('(X)') || u.includes('YUKARI') || u.includes('NORTHING')) && colMap.northing === undefined)
            colMap.northing = cIdx;
          else if (u.includes('AÇIKLAMA') || u.includes('ACIKLAMA') || u.includes('REMARK')) colMap.remarks = cIdx;
          else if (u.includes('PROFİL') || u.includes('PROFIL')) colMap.profile_no = cIdx;
          else if (u.includes('BUZ') || u.includes('ICE')) colMap.ice_zone = cIdx;
        });
      }
    }

    for (let r = headerRowIdx + 1; r < grid.length; r++) {
      const row = grid[r];
      if (!row || row.length === 0) continue;
      const lineStr = row
        .map((c: any) => String(c ?? '').trim())
        .filter(Boolean)
        .join(' ');
      if (!lineStr) continue;
      allTextLines.push(lineStr);

      // Önce tam satır ayrıştırıcıyı dene (standart 27 sütunlu TEİAŞ DTL dizilimi için)
      const byLine = parseDtlLine(lineStr);
      if (byLine) {
        structuredRows.push(byLine);
        continue;
      }

      // Sütun başlık eşleşmesi varsa doğrudan hücrelerden oku
      if (headerRowIdx >= 0 && colMap.pole !== undefined && colMap.ttype !== undefined) {
        const pole = String(row[colMap.pole] ?? '').trim();
        const ttype = String(row[colMap.ttype] ?? '').trim().toUpperCase();
        if (!pole || /^(?:DİREK|DIREK|TOWER|\(\d+\))$/i.test(pole)) continue;
        const stText = colMap.station !== undefined ? String(row[colMap.station] ?? '').trim() : '';
        let stM: number | null = null;
        const mSt = stText.match(/^(\d{1,3})\+(\d{3}(?:[.,]\d{1,2})?)$/);
        if (mSt) {
          stM = parseFloat(mSt[1]) * 1000 + parseFloat(mSt[2].replace(',', '.'));
        } else {
          stM = toNum(stText);
        }
        structuredRows.push({
          pole,
          span_m: colMap.span_m !== undefined ? toNum(row[colMap.span_m]) : null,
          wind_span_m: colMap.wind_span_m !== undefined ? toNum(row[colMap.wind_span_m]) : null,
          weight_span_m: colMap.weight_span_m !== undefined ? toNum(row[colMap.weight_span_m]) : null,
          station_text: stText,
          station_m: stM,
          some_no: colMap.some_no !== undefined ? String(row[colMap.some_no] ?? '').trim() : '',
          line_angle_grad: colMap.angle !== undefined ? toNum(row[colMap.angle]) : null,
          crossing: colMap.crossing !== undefined ? normalizeCrossing(String(row[colMap.crossing] ?? '')) : '',
          function: colMap.func !== undefined ? String(row[colMap.func] ?? '').trim().toUpperCase() : '',
          tower_type: ttype,
          nominal_height_m: colMap.height !== undefined ? toNum(row[colMap.height]) : null,
          body_ext_m: colMap.body_ext !== undefined ? toNum(row[colMap.body_ext]) : null,
          hook_diff_m: colMap.hook_diff !== undefined ? toNum(row[colMap.hook_diff]) : null,
          center_ext_m: colMap.center_ext !== undefined ? toNum(row[colMap.center_ext]) : null,
          leg_a_m: colMap.leg_a !== undefined ? toNum(row[colMap.leg_a]) : null,
          leg_b_m: colMap.leg_b !== undefined ? toNum(row[colMap.leg_b]) : null,
          leg_c_m: colMap.leg_c !== undefined ? toNum(row[colMap.leg_c]) : null,
          leg_d_m: colMap.leg_d !== undefined ? toNum(row[colMap.leg_d]) : null,
          ground_elev_m: colMap.elev !== undefined ? toNum(row[colMap.elev]) : null,
          insulator_set: colMap.ins_set !== undefined ? String(row[colMap.ins_set] ?? '').trim().toUpperCase() : '',
          insulator_count: colMap.ins_count !== undefined ? String(row[colMap.ins_count] ?? '').trim() : '',
          insulator_ref: colMap.ins_ref !== undefined ? String(row[colMap.ins_ref] ?? '').trim().toUpperCase() : '',
          easting: colMap.easting !== undefined ? toNum(row[colMap.easting]) : null,
          northing: colMap.northing !== undefined ? toNum(row[colMap.northing]) : null,
          remarks: colMap.remarks !== undefined ? normalizeRemarks(String(row[colMap.remarks] ?? '')) : '',
          profile_no: colMap.profile_no !== undefined ? toNum(row[colMap.profile_no]) : null,
          ice_zone: colMap.ice_zone !== undefined ? toNum(row[colMap.ice_zone]) : null,
        });
      }
    }
  }

  const header = parseDtlHeaderText(allTextLines.join('\n'));
  return {
    header,
    rows: finalizeDtlRows(structuredRows),
  };
}
