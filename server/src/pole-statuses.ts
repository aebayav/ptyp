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

export function poleProgress(status: string | null | undefined): number {
  return POLE_STATUSES[status || 'none']?.progress ?? 0;
}

// "D-14", "D14", "14(S)" → 14; "Portal-Başlangıç" → null
export function poleNumberFromName(name: string | null | undefined): number | null {
  const m = String(name || '').match(/^D[-.\s]?(\d{1,4})/i);
  return m ? parseInt(m[1], 10) : null;
}
