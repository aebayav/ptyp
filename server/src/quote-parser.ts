// Teklif dosyalarından malzeme-fiyat tespiti (PDF/Excel/Word/CSV metninden)

export interface DetectedQuote {
  material_id: number;
  material_name: string;
  price: number;
  currency: string;
  line: string;
}

interface MaterialRef {
  id: number;
  name: string;
}

// Türkçe karakter katlama + noktalama temizleme → esnek eşleştirme
const trFold = (s: string): string =>
  s
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ç/g, 'c')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// "1.234,56" (TR), "1,234.56" (US), "1234", "1,234" (binlik) desteklenir
export function parsePriceToken(token: string): number | null {
  const t = token
    .replace(/[₺€$]/g, '')
    .replace(/\bTL\b|\bTRY\b|\bUSD\b|\bEUR\b/gi, '')
    .trim();
  if (!t) return null;
  const hasComma = t.includes(',');
  const hasDot = t.includes('.');
  let value: number;
  if (hasComma && hasDot) {
    if (t.lastIndexOf(',') > t.lastIndexOf('.')) {
      value = parseFloat(t.replace(/\./g, '').replace(',', '.')); // TR: 1.234,56
    } else {
      value = parseFloat(t.replace(/,/g, '')); // US: 1,234.56
    }
  } else if (hasComma) {
    const dec = t.split(',').pop()!;
    if (dec.length <= 2) value = parseFloat(t.replace(/\./g, '').replace(',', '.'));
    else value = parseFloat(t.replace(/,/g, ''));
  } else if (hasDot) {
    const dec = t.split('.').pop()!;
    if (dec.length <= 2) value = parseFloat(t);
    else value = parseFloat(t.replace(/\./g, ''));
  } else {
    value = parseFloat(t);
  }
  return Number.isFinite(value) && value > 0 ? value : null;
}

function detectCurrency(line: string): string {
  if (/€|EUR/i.test(line)) return 'EUR';
  if (/\$|USD/i.test(line)) return 'USD';
  return 'TRY';
}

const PRICE_TOKEN_RE =
  /((?:₺|€|\$)?\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?\s?(?:₺|€|\$|TL|TRY|USD|EUR)?)/g;

// Satırdaki en "güvenilir" fiyatı bul: para birimi simgesi > ayraçlı > düz sayı
function extractPrice(line: string): { value: number; currency: string } | null {
  let best: { value: number; score: number } | null = null;
  let m: RegExpExecArray | null;
  const re = new RegExp(PRICE_TOKEN_RE.source, 'g');
  while ((m = re.exec(line))) {
    const token = m[1];
    const value = parsePriceToken(token);
    if (value === null) continue;
    const bare = token.replace(/[^0-9]/g, '');
    // 4 haneli, ayraçsız, 1900-2100 arası → muhtemelen yıl, atla
    if (!/[.,]/.test(token) && bare.length === 4 && value >= 1900 && value <= 2100) continue;
    let score = 0;
    if (/[₺€$]|TL|TRY|USD|EUR/i.test(token)) score += 4;
    if (/[.,]/.test(token)) score += 2;
    if (!best || score > best.score) best = { value, score };
  }
  return best ? { value: best.value, currency: detectCurrency(line) } : null;
}

// Regex'te özel karakterleri kaçır
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Her malzeme için dosya metninde isim ara → aynı (veya sonraki) satırda fiyat bul
export function detectQuotes(text: string, materials: MaterialRef[]): DetectedQuote[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const found: DetectedQuote[] = [];
  for (const m of materials) {
    const normName = trFold(m.name);
    if (normName.length < 4) continue;
    for (let i = 0; i < lines.length; i++) {
      // İsim bu satırda olmalı; fiyat bu veya bir sonraki satırda aranır
      const normLine = trFold(lines[i]);
      if (!normLine.includes(normName)) continue;
      // İsmin içindeki rakamlar (örn. "954 MCM") fiyat sanılmasın diye ismi satırdan çıkar
      const stripped = lines[i].replace(new RegExp(escapeRegExp(m.name), 'gi'), ' ');
      const price = extractPrice(stripped) || extractPrice(lines[i + 1] || '');
      if (!price) continue;
      found.push({
        material_id: m.id,
        material_name: m.name,
        price: price.value,
        currency: price.currency,
        line: `${lines[i]}${lines[i + 1] ? ' | ' + lines[i + 1] : ''}`.slice(0, 240),
      });
      break; // malzeme başına ilk eşleşme yeterli
    }
  }
  return found;
}

// Fiyat içeren ama hiçbir malzemeyle eşleşmeyen satırlar (önizleme için)
export function unmatchedLines(text: string, matchedNames: string[]): string[] {
  const normMatched = matchedNames.map(trFold);
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (!extractPrice(l)) return false;
      if (normMatched.some((n) => n && trFold(l).includes(n))) return false;
      // Saf fiyat satırlarını ("1.850,50 TL" gibi) ele; anlamlı içerik olmalı
      const letters = trFold(l).replace(/[^a-z]/g, '').replace(/tl|try|usd|eur/g, '');
      return letters.length >= 4;
    })
    .slice(0, 10);
}
