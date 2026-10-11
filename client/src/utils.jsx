export const CURRENCIES = ['TRY', 'USD', 'EUR'];

export const UNITS = ['adet', 'm', 'km', 'kg', 'ton', 'takım', 'set', 'varil'];

export const CATEGORY_SUGGESTIONS = [
  'ENH - Direk',
  'ENH - İletken',
  'ENH - İzolatör / Donanım',
  'ENH - Koruma İletkeni (OPGW)',
  'Trafo Merkezi - Güç Trafosu',
  'Trafo Merkezi - Şalt Ekipmanı',
  'Trafo Merkezi - Koruma & Kontrol',
  'Trafo Merkezi - Ölçü Ekipmanı',
  'Kablo',
  'Topraklama',
  'Aydınlatma',
  'Diğer',
];

export const MATERIAL_STATUS = {
  open: { label: 'Teklif Toplanıyor', cls: 'badge-blue' },
  evaluating: { label: 'Değerlendirmede', cls: 'badge-amber' },
  ordered: { label: 'Sipariş Verildi', cls: 'badge-green' },
  delivered: { label: 'Teslim Alındı', cls: 'badge-gray' },
};

export const QUOTE_STATUS = {
  requested: { label: 'Talep Edildi', cls: 'badge-amber' },
  received: { label: 'Teklif Alındı', cls: 'badge-blue' },
  selected: { label: 'Seçildi ✓', cls: 'badge-green' },
};

export function fmtMoney(value, currency = 'TRY') {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '—';
  try {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(value);
  }
}

export function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(String(s).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('tr-TR');
}

export function badge(meta) {
  return meta ? `<span class="badge ${meta.cls}">${meta.label}</span>` : '';
}

export function StatusBadge({ meta }) {
  if (!meta) return null;
  return <span className={`badge ${meta.cls}`}>{meta.label}</span>;
}

// Test/şeffaflık: belgenin hangi yöntemle okunduğunu açıklar
export function okumaBilgisi(d) {
  if (!d) return '';
  const yontem = {
    excel: '📊 Excel dosyası (hücre okuma)',
    'pdf-text': '📄 PDF metin katmanı',
    'pdf-ocr': '📄 PDF taranmış → OCR (RapidOCR)',
    'tiff-ocr': '🖼️ TIFF → OCR (RapidOCR)',
  }[d.source] || `Kaynak: ${d.source}`;
  let s = yontem;
  if (d.utm_zone_used) s += ` · Koordinat: UTM zone ${d.utm_zone_used} → WGS84 dönüşümü`;
  if (d.tm3_cm_used) s += ` · Koordinat: ITRF-96 3°TM (CM ${d.tm3_cm_used}) → WGS84 dönüşümü`;
  const pages = d.ocr?.pages || [];
  if (pages.length) {
    const cells = pages.flatMap((p) => p.rows.flat());
    const ai = cells.filter((c) => c.fallback === 'ollama').length;
    s += ` · ${pages.length} sayfa, ${cells.length} hücre`;
    if (ai > 0) s += ` · 🤖 AI (ptyp-ai) ${ai} hücre düzeltti`;
  }
  const unc = d.ocr?.uncertain?.length || 0;
  if (unc > 0) s += ` · ⚠️ ${unc} satır düşük güven`;
  return s;
}
