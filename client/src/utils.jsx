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
