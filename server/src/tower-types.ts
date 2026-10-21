// ENH direk tipi sözlüğü + OCR bozulmalarını düzelten bulanık eşleştirici.
// OCR 'PF1' yerine 'PFT', 'PB1' yerine 'PBI' gibi okuyabilir; bu, keşife (BOQ)
// sahte bir tip satırı olarak yansıyordu. Bu modül okunan tipi bilinen tip
// kümesiyle ağırlıklı uzaklıkla eşleştirir: yüksek güvenli eşleşmede düzeltir,
// belirsizse OLDUĞU GİBİ bırakır (sessizce uydurma yapılmaz — kullanıcı görür).

const PREFIXES = ['PA', 'PB', 'PC', 'PD', 'PE', 'PF'];
const DOUBLE = ['2FS', '2FN'];

function buildVocabulary(): string[] {
  const out = new Set<string>(['PORTAL']);
  for (const p of PREFIXES) {
    out.add(p); // rakamı okunamayan çıplak tip (PB, PF...) geçerli kalır
    for (let d = 1; d <= 6; d++) out.add(p + d);
  }
  for (const p of DOUBLE) {
    out.add(p);
    for (let d = 1; d <= 3; d++) out.add(p + d);
  }
  return [...out];
}

export const TOWER_TYPES: string[] = buildVocabulary();
const VOCAB = new Set(TOWER_TYPES);

// OCR karakter karışma maliyetleri (0 = aynı karakter, 1.0 = alakasız değişim)
const CONF: Record<string, number> = {
  '1T': 0.5, T1: 0.5, '1I': 0.5, I1: 0.5, '1L': 0.5, L1: 0.5,
  '5S': 0.5, S5: 0.5,
  '0O': 0.5, O0: 0.5, '0D': 0.6, D0: 0.6, OD: 0.5, DO: 0.5,
  '0Q': 0.6, Q0: 0.6, OQ: 0.6, QO: 0.6,
  B8: 0.5, '8B': 0.5, B3: 0.6, '3B': 0.6,
  EF: 0.5, FE: 0.5, PF: 0.5, FP: 0.5, FT: 0.7, TF: 0.7, ET: 0.7, TE: 0.7, EP: 0.8, PE: 0.8,
  PR: 0.6, RP: 0.6, BR: 0.8, RB: 0.8,
  Z2: 0.6, '2Z': 0.6, Z7: 0.6, '7Z': 0.6, '17': 0.7, '71': 0.7,
  A4: 0.6, '4A': 0.6, AR: 0.8, RA: 0.8,
  CG: 0.6, GC: 0.6, C0: 0.7, '0C': 0.7, CO: 0.7, OC: 0.7,
  G6: 0.6, '6G': 0.6, G0: 0.7, '0G': 0.7, GO: 0.7, OG: 0.7,
  '68': 0.7, '86': 0.7, B6: 0.7, '6B': 0.7,
  '36': 0.7, '63': 0.7,
};

const subCost = (a: string, b: string): number => {
  if (a === b) return 0;
  const k = a + b;
  return CONF[k] ?? 1.0;
};

// Ağırlıklı Levenshtein + bitişik takas (ekleme/silme 1.2: kısa tiplerde
// harf sayısı korunur, tek harf düşmesi/yapışması düzeltme sayılmaz)
function weightedDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i * 1.2;
  for (let j = 0; j <= n; j++) dp[0][j] = j * 1.2;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const sub = dp[i - 1][j - 1] + subCost(a[i - 1], b[j - 1]);
      const del = dp[i - 1][j] + 1.2;
      const ins = dp[i][j - 1] + 1.2;
      dp[i][j] = Math.min(sub, del, ins);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 0.8);
      }
    }
  }
  return dp[m][n];
}

export function normalizeTowerType(raw: unknown): string {
  if (raw == null) return '';
  const s = String(raw)
    .toUpperCase()
    .replace(/\(.*\)$/, '')
    .replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  if (VOCAB.has(s)) return s;
  let best: string | null = null;
  let bestD = Infinity;
  let secondD = Infinity;
  for (const t of TOWER_TYPES) {
    const d = weightedDistance(s, t);
    if (d < bestD) {
      secondD = bestD;
      bestD = d;
      best = t;
    } else if (d < secondD) {
      secondD = d;
    }
  }
  // Yalnız yüksek güven: maliyet ≤ 1.0 VE ikinci adaydan en az 0.4 uzak
  if (best !== null && bestD <= 1.0 && bestD + 0.4 <= secondD) return best;
  return s; // eşleşmedi — ham hali kalır (kullanıcı görsün, uydurulmaz)
}

// DTL satırlarında tip düzeltmesi yap; düzeltilenlerin ham hali tower_type_raw'a yazılır
export function normalizeDtlRowTypes<T extends { tower_type?: string | null; tower_type_raw?: string }>(
  rows: T[]
): T[] {
  for (const r of rows) {
    const orig = (r.tower_type || '').trim();
    if (!orig) continue;
    const cleaned = orig
      .toUpperCase()
      .replace(/\(.*\)$/, '')
      .replace(/[^A-Z0-9]/g, '');
    const t = normalizeTowerType(orig);
    if (t && t !== cleaned) {
      (r as any).tower_type_raw = orig;
      r.tower_type = t;
    }
  }
  return rows;
}
