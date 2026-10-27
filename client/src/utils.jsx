import { useEffect, useState } from 'react';
import { api } from './api';

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
  selected: { label: 'Seçildi', cls: 'badge-green' },
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

export function fmtNum(value, maximumFractionDigits = 3) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('tr-TR', { maximumFractionDigits });
}

export function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(String(s).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('tr-TR');
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function StatusBadge({ meta }) {
  if (!meta) return null;
  return <span className={`badge ${meta.cls}`}>{meta.label}</span>;
}

// Harita sayfalarının (RouteMap, Kamulastirma, Saha) ortak kullandığı dinamik Leaflet yükleyicisi
let leafletPromise = null;
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => {
      leafletPromise = null;
      reject(new Error('Harita kütüphanesi yüklenemedi (internet gerekli).'));
    };
    document.head.appendChild(js);
  });
  return leafletPromise;
}

const PROJECT_KEY = 'ptyp_project_id';

// Tüm proje bazlı sayfalar arasında seçili projeyi korur (localStorage + ortak yükleme)
export function useProjects(preferredId = null) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectIdState] = useState(() => {
    const pref = preferredId != null ? Number(preferredId) : NaN;
    if (Number.isInteger(pref) && pref > 0) return pref;
    try {
      const saved = Number(localStorage.getItem(PROJECT_KEY));
      return Number.isInteger(saved) && saved > 0 ? saved : null;
    } catch {
      return null;
    }
  });

  function setProjectId(idOrFn) {
    setProjectIdState((prev) => {
      const raw = typeof idOrFn === 'function' ? idOrFn(prev) : idOrFn;
      const next = raw == null || raw === '' ? null : Number(raw);
      try {
        if (next != null && Number.isFinite(next)) localStorage.setItem(PROJECT_KEY, String(next));
        else localStorage.removeItem(PROJECT_KEY);
      } catch {
        /* localStorage kapalıysa sessiz geç */
      }
      return next;
    });
  }

  async function reloadProjects() {
    const p = await api.get('/api/projects');
    setProjects(p);
    setProjectId((prev) => {
      const pref = preferredId != null ? Number(preferredId) : null;
      if (pref && p.some((x) => x.id === pref)) return pref;
      if (prev && p.some((x) => x.id === prev)) return prev;
      return p[0]?.id ?? null;
    });
    return p;
  }

  useEffect(() => {
    reloadProjects().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { projects, projectId, setProjectId, reloadProjects };
}

export function ProjectBar({ projects, projectId, onChange, formatOption, children }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
      <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
        PROJE:
      </span>
      <select value={projectId ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {formatOption ? formatOption(p) : p.name}
          </option>
        ))}
      </select>
      {children}
    </div>
  );
}

// Test/şeffaflık: belgenin hangi yöntemle okunduğunu açıklar
export function okumaBilgisi(d) {
  if (!d) return '';
  const yontem =
    {
      excel: 'Excel dosyası (hücre okuma)',
      'pdf-text': 'PDF metin katmanı',
      'pdf-ocr': 'PDF taranmış OCR (RapidOCR)',
      'tiff-ocr': 'TIFF OCR (RapidOCR)',
    }[d.source] || `Kaynak: ${d.source}`;
  let s = yontem;
  if (d.utm_zone_used) s += ` · Koordinat: UTM zone ${d.utm_zone_used} → WGS84 dönüşümü`;
  if (d.tm3_cm_used) s += ` · Koordinat: ITRF-96 3°TM (CM ${d.tm3_cm_used}) → WGS84 dönüşümü`;
  const pages = d.ocr?.pages || [];
  if (pages.length) {
    const cells = pages.flatMap((p) => p.rows.flat());
    const ai = cells.filter((c) => c.fallback === 'ollama').length;
    s += ` · ${pages.length} sayfa, ${cells.length} hücre`;
    if (ai > 0) s += ` · AI (ptyp-ai) ${ai} hücre düzeltti`;
  }
  const unc = d.ocr?.uncertain?.length || 0;
  if (unc > 0) s += ` · ${unc} satır düşük güven`;
  return s;
}
