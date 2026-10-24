// Tarih alanları (DATE sütunları) için istek gövdesi dönüştürücüsü.
// İstemci boş alan için '' gönderir → NULL. 'YYYY-MM-DD' (input type=date) ve
// 'GG.AA.YYYY' kabul edilir; geçersiz değerde hata fırlatılır.

export class InvalidDateError extends Error {
  status = 400;
  constructor(field: string, value: unknown) {
    super(`Geçersiz tarih (${field}): "${String(value)}". Biçim YYYY-AA-GG olmalı.`);
  }
}

function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function toDateOrNull(value: unknown, field = 'tarih'): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (isRealDate(y, mo, d)) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (isRealDate(y, mo, d)) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  throw new InvalidDateError(field, value);
}
