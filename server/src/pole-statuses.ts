// Saha direk durumları — saha.ts, workgroups.ts ve overview.ts'in ortak kullandığı
// durum etiketleri, renkler ve ilerleme ağırlıkları.
export const POLE_STATUSES: Record<string, { label: string; color: string; progress: number }> = {
  none: { label: 'Başlamadı', color: '#94a3b8', progress: 0 },
  excavation: { label: 'Kazı', color: '#d97706', progress: 15 },
  foundation: { label: 'Temel', color: '#b45309', progress: 30 },
  erection: { label: 'Direk Montajı', color: '#2563eb', progress: 50 },
  fittings: { label: 'Donanım (Askı/Gergi)', color: '#7c3aed', progress: 70 },
  stringing: { label: 'İletken Çekimi', color: '#0891b2', progress: 85 },
  completed: { label: 'Tamamlandı', color: '#16a34a', progress: 100 },
  issue: { label: 'Sorun / Engel', color: '#8b1d1d', progress: 0 },
};

// İş gruplarının bağlanabileceği saha aşamaları (minProgress: o aşamayı tamamlanmış saymak için gereken direk ilerlemesi)
export const SAHA_STAGES: Record<string, { label: string; minProgress: number }> = {
  '': { label: 'Genel Direk Ortalaması', minProgress: 0 },
  all: { label: 'Genel Direk Ortalaması', minProgress: 0 },
  excavation: { label: 'Kazı Aşaması (≥Kazı)', minProgress: 15 },
  foundation: { label: 'Temel Aşaması (≥Temel)', minProgress: 30 },
  erection: { label: 'Direk Montajı (≥Montaj)', minProgress: 50 },
  fittings: { label: 'Donanım / İzolatör (≥Donanım)', minProgress: 70 },
  stringing: { label: 'İletken Çekimi (≥Tel Çekimi)', minProgress: 85 },
  completed: { label: 'Tamamlanma (Tamamlandı)', minProgress: 100 },
};

export function poleProgress(status: string | null | undefined): number {
  return POLE_STATUSES[status || 'none']?.progress ?? 0;
}

/** Belirli bir saha aşaması için tek direğin katkı yüzdesi (0..100). */
export function poleStageProgress(status: string | null | undefined, sahaStage?: string | null): number {
  const prog = poleProgress(status);
  const stg = String(sahaStage || '').trim();
  const minP = SAHA_STAGES[stg]?.minProgress ?? 0;
  if (minP <= 0) return prog;
  return prog >= minP ? 100 : 0;
}

// "D-14", "D14", "14(S)", "Direk 14" → 14; "Portal-Başlangıç" → null
export function poleNumberFromName(name: string | null | undefined): number | null {
  const s = String(name || '').trim();
  if (!s || /^portal/i.test(s)) return null;
  const m = s.match(/^(?:(?:direk|dp|d|p)[-._\s]*)?(\d{1,4})(?:\s*\([A-Za-z0-9]+\))?/i);
  return m ? parseInt(m[1], 10) : null;
}
