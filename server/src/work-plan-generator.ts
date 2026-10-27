// Otomatik İş Planı Oluşturucu & Saha İlerlemesi Senkronizasyonu
// Proje tipi (ENH/TM/GES/RES), başlangıç-bitiş takvimi, direk listesi (poles),
// DTL tablosu (project_dtl), keşif (kesif_items) ve kamulaştırma (parcels)
// verilerinden otomatik iş grupları (work_groups) ve görevler (tasks) üretir.
import type { Pool, PoolClient } from 'pg';
import { pool } from './db';
import { poleNumberFromName, poleStageProgress } from './pole-statuses';

export interface PhaseTemplate {
  code: string;
  name: string;
  weight: number;
  startFrac: number;
  endFrac: number;
  saha_stage: string;
  notes: string;
  defaultTasks: { title: string; description: string; priority: 'low' | 'normal' | 'high'; frac: number }[];
}

export const PHASE_TEMPLATES: Record<string, PhaseTemplate[]> = {
  enh: [
    {
      code: 'FAZ-01',
      name: 'Etüt, Aplikasyon & Kamulaştırma / İzinler',
      weight: 8,
      startFrac: 0.0,
      endFrac: 0.25,
      saha_stage: '',
      notes: 'Güzergah aplikasyonu, zemin etüdü, kurum geçiş izinleri ve irtifak işlemleri',
      defaultTasks: [
        { title: 'Güzergah aplikasyon ve direk yeri kazıklarının çakılması', description: 'DTL koordinatlarına göre saha aplikasyon kontrolü', priority: 'high', frac: 0.35 },
        { title: 'Zemin etüdü ve temel tipi doğrulaması', description: 'Direk noktalarında zemin sınıfı ve temel tipi teyidi', priority: 'normal', frac: 0.65 },
        { title: 'Kurum geçiş izinleri ve muvafakat dosyalarının tamamlanması', description: 'Karayolu, E.İ.H., demiryolu ve orman izinlerinin takibi', priority: 'high', frac: 0.9 },
      ],
    },
    {
      code: 'FAZ-02',
      name: 'Hafriyat & Temel Kazıları',
      weight: 15,
      startFrac: 0.1,
      endFrac: 0.45,
      saha_stage: 'excavation',
      notes: 'Direk temel çukurlarının açılması, ulaşım yolları ve derinlik/kot kontrolü',
      defaultTasks: [
        { title: 'Direk ulaşım yolları ve çalışma platformlarının açılması', description: 'İş makinesi erişimi için servis yollarının hazırlanması', priority: 'normal', frac: 0.25 },
        { title: 'Temel kazılarının tamamlanması ve kot/ebat kabulü', description: 'Temel çukurlarının proje ölçülerine göre kontrolü', priority: 'high', frac: 0.85 },
      ],
    },
    {
      code: 'FAZ-03',
      name: 'Temel Betonu & Ankraj Montajı',
      weight: 18,
      startFrac: 0.18,
      endFrac: 0.55,
      saha_stage: 'foundation',
      notes: 'Grobeton, ankraj/stub ayarı, demir donatı, kalıp, C25/C30 beton dökümü ve topraklama',
      defaultTasks: [
        { title: 'Ankraj (stub) montajı, şablon ve diyagonal mastar kontrolü', description: 'Direk ayak açıklığı ve terazi ölçümlerinin tutanak altına alınması', priority: 'high', frac: 0.4 },
        { title: 'Temel betonu dökümü, numune alımı ve topraklama şeridi montajı', description: 'Beton mukavemet takibi ve direk topraklama geçiş direnci ölçümü', priority: 'high', frac: 0.85 },
      ],
    },
    {
      code: 'FAZ-04',
      name: 'Direk Montajı (Dikim)',
      weight: 22,
      startFrac: 0.32,
      endFrac: 0.75,
      saha_stage: 'erection',
      notes: 'Galvanizli çelik kafes direklerin sahaya sevki, yerde çatkı, dikim ve tork kontrolü',
      defaultTasks: [
        { title: 'Direk çelik profillerinin sahaya sevki ve tasnifi', description: 'Direk tip ve gövde uzatmalarına göre direk dibi dağıtımı', priority: 'normal', frac: 0.25 },
        { title: 'Direk dikimi, şakül/eksen kontrolü ve cıvata torklama/zımbalama', description: 'Tüm gövde ve travers cıvatalarının sıkılık kontrolü', priority: 'high', frac: 0.9 },
      ],
    },
    {
      code: 'FAZ-05',
      name: 'İzolatör & Hırdavat Montajı',
      weight: 10,
      startFrac: 0.5,
      endFrac: 0.85,
      saha_stage: 'fittings',
      notes: 'Askı ve gergi izolatör zincirleri, ark boynuzları ve tel çekim makaralarının montajı',
      defaultTasks: [
        { title: 'Askı ve çift gergi izolatör takımlarının montajı', description: 'DTL izolatör setlerine (A, ÇA, ÇGÇG) uygun montaj ve makara asımı', priority: 'normal', frac: 0.8 },
      ],
    },
    {
      code: 'FAZ-06',
      name: 'İletken & Koruma Teli Çekimi (Sehim)',
      weight: 20,
      startFrac: 0.62,
      endFrac: 0.94,
      saha_stage: 'stringing',
      notes: 'Fren-cer ile faz iletkenleri ve OPGW/koruma teli çekimi, sehim ayarı, klemp ve damper montajı',
      defaultTasks: [
        { title: 'Kılavuz halat ve 3 faz iletken + koruma teli/OPGW çekimi', description: 'Geçiş noktalarında emniyet iskeleleri kurularak tel çekimi', priority: 'high', frac: 0.6 },
        { title: 'Sehim (salgı) ayarı, sıkma/askı klempleri, damper ve ikaz küreleri montajı', description: 'Sıcaklık-sehim cetveline göre sehim verilmesi ve jumper bağlantıları', priority: 'high', frac: 0.92 },
      ],
    },
    {
      code: 'FAZ-07',
      name: 'Test, Geçici Kabul & Devreye Alma',
      weight: 7,
      startFrac: 0.88,
      endFrac: 1.0,
      saha_stage: 'completed',
      notes: 'Hat boyu son kontroller, numarataj/ölüm tehlike levhaları, topraklama ölçümleri ve geçici kabul',
      defaultTasks: [
        { title: 'Direk numarataj, ölüm tehlike ve faz plakalarının montajı', description: 'Tüm direklerde levha ve dikenli tel/tırmanma engeli kontrolü', priority: 'normal', frac: 0.4 },
        { title: 'Topraklama direnci ölçümleri, izolasyon testi ve Geçici Kabul', description: 'Kabul heyeti saha gezisi, eksik listesi (punch list) kapatma ve enerjilendirme', priority: 'high', frac: 0.95 },
      ],
    },
  ],
  tm: [
    {
      code: 'FAZ-01',
      name: 'Saha Tesviye, Drenaj & Çevre İhata',
      weight: 12,
      startFrac: 0.0,
      endFrac: 0.25,
      saha_stage: 'excavation',
      notes: 'Trafo merkezi saha kazı/dolgu, istinat duvarı, drenaj ve çevre güvenlik çiti',
      defaultTasks: [
        { title: 'Saha aplikasyonu, terasman kazı/dolgu ve sıkıştırma testleri', description: 'Şalt sahası kotlarının projeye göre hazırlanması', priority: 'high', frac: 0.6 },
        { title: 'Çevre ihata duvarı, tel çit ve saha drenaj altyapısı', description: 'Yağmur suyu drenajı ve saha içi yollar', priority: 'normal', frac: 0.9 },
      ],
    },
    {
      code: 'FAZ-02',
      name: 'Kumanda Binası & Cihaz/Portal Temelleri',
      weight: 22,
      startFrac: 0.12,
      endFrac: 0.5,
      saha_stage: 'foundation',
      notes: 'Güç trafosu temeli (yağ çukuru), kesici/ayırıcı/portal temelleri, kablo kanalları ve kumanda binası',
      defaultTasks: [
        { title: 'Portal ve yüksek gerilim cihaz temellerinin dökümü', description: 'Ankraj cıvataları ve kablo büz geçişlerinin kontrolü', priority: 'high', frac: 0.5 },
        { title: 'Güç trafosu temeli, yağ toplama çukuru ve kumanda binası inşaatı', description: 'Kablo galerileri ve bina ince işlerinin tamamlanması', priority: 'high', frac: 0.9 },
      ],
    },
    {
      code: 'FAZ-03',
      name: 'Şalt Sahası Çelik Konstrüksiyon & Portal Montajı',
      weight: 15,
      startFrac: 0.35,
      endFrac: 0.65,
      saha_stage: 'erection',
      notes: 'A-portal, kiriş ve cihaz mesnet çelik konstrüksiyonlarının montajı',
      defaultTasks: [
        { title: 'Portal direkleri, traversler ve cihaz sehpalarının montajı', description: 'Tork ve şakül kontrollerinin yapılması', priority: 'high', frac: 0.8 },
      ],
    },
    {
      code: 'FAZ-04',
      name: 'Primer Teçhizat & Bara Montajı',
      weight: 22,
      startFrac: 0.45,
      endFrac: 0.8,
      saha_stage: 'fittings',
      notes: 'Güç trafosu, kesici, ayırıcı, ölçü trafoları, parafudr ve boru/esnek bara montajı',
      defaultTasks: [
        { title: 'Güç trafosu indirme, montaj ve yağ/aksesuar işlemleri', description: 'Buchholz, silikajel, buşing ve soğutma grubu montajı', priority: 'high', frac: 0.5 },
        { title: 'Kesici, ayırıcı, ölçü trafoları ve bara/iletken bağlantıları', description: 'Primer klemens ve bara geçişlerinin tamamlanması', priority: 'high', frac: 0.9 },
      ],
    },
    {
      code: 'FAZ-05',
      name: 'Sekonder Panolar, Koruma Röleleri & SCADA',
      weight: 14,
      startFrac: 0.55,
      endFrac: 0.88,
      saha_stage: 'stringing',
      notes: 'Kumanda/koruma panoları, OG hücreler, AC/DC yardımcı servis, akü-redresör ve RTU/SCADA',
      defaultTasks: [
        { title: 'Kumanda, koruma, senkronizasyon ve AC/DC yardımcı servis panoları montajı', description: 'Akü grubu ve redresör devreye alma', priority: 'high', frac: 0.6 },
        { title: 'RTU / SCADA haberleşme ve TEİAŞ/dağıtım sinyal testleri', description: 'Noktadan noktaya sinyal doğrulaması', priority: 'high', frac: 0.9 },
      ],
    },
    {
      code: 'FAZ-06',
      name: 'Güç/Kumanda Kablajı & Topraklama Ağı',
      weight: 9,
      startFrac: 0.6,
      endFrac: 0.92,
      saha_stage: '',
      notes: 'Bakır topraklama ağının serilmesi, OG/AG güç ve sekonder kumanda kablolarının çekimi',
      defaultTasks: [
        { title: 'Topraklama ağı (bakır iletken/kazık) ve klemens bağlantıları', description: 'Termokaynak ve cihaz gövde topraklamaları', priority: 'high', frac: 0.5 },
        { title: 'Kumanda/ölçü kablolarının çekimi, etiketleme ve uç bağlantıları', description: 'Megger kontrolü ve ferül/etiketleme', priority: 'normal', frac: 0.9 },
      ],
    },
    {
      code: 'FAZ-07',
      name: 'Primer/Sekonder Testler & Geçici Kabul',
      weight: 6,
      startFrac: 0.86,
      endFrac: 1.0,
      saha_stage: 'completed',
      notes: 'Trafo, kesici, koruma rölesi sekonder enjeksiyon testleri ve geçici kabul',
      defaultTasks: [
        { title: 'Primer ve sekonder koruma rölesi fonksiyon testleri', description: 'Test raporlarının onaylanması ve enerjilendirme', priority: 'high', frac: 0.95 },
      ],
    },
  ],
  ges: [
    {
      code: 'FAZ-01',
      name: 'Saha Tesviye, Tel Çit & Yol Açımı',
      weight: 10,
      startFrac: 0.0,
      endFrac: 0.22,
      saha_stage: 'excavation',
      notes: 'GES saha tesviyesi, çevre güvenlik çiti, aydınlatma ve iç servis yolları',
      defaultTasks: [
        { title: 'Saha tesviyesi, çevre tel çit ve kamera/aydınlatma altyapısı', description: 'Saha sınır aplikasyonu ve güvenlik çiti', priority: 'normal', frac: 0.8 },
      ],
    },
    {
      code: 'FAZ-02',
      name: 'Çakma / Temel & Çelik Konstrüksiyon (Sehpa)',
      weight: 22,
      startFrac: 0.12,
      endFrac: 0.5,
      saha_stage: 'erection',
      notes: 'Galvanizli çelik profillerin (ramming) çakılması ve panel taşıyıcı masa montajı',
      defaultTasks: [
        { title: 'Çelik ayak çakma (ramming) ve çekme (pull-out) testleri', description: 'Aplikasyon koordinatlarına göre ayak çakımı', priority: 'high', frac: 0.5 },
        { title: 'Panel taşıyıcı çelik konstrüksiyon (masa/pürlin) montajı', description: 'Eğim açısı ve tork kontrolleri', priority: 'high', frac: 0.9 },
      ],
    },
    {
      code: 'FAZ-03',
      name: 'PV Panel Montajı',
      weight: 26,
      startFrac: 0.3,
      endFrac: 0.72,
      saha_stage: 'fittings',
      notes: 'Fotovoltaik panellerin sevki, masalara dizilmesi ve orta/kenar klemp montajı',
      defaultTasks: [
        { title: 'PV modüllerin sahaya dağıtımı ve klemp montajı', description: 'Seri/barkod kaydı ve mekanik montaj kontrolü', priority: 'high', frac: 0.85 },
      ],
    },
    {
      code: 'FAZ-04',
      name: 'İnverter, Trafo Köşkü & AG/OG Hücre Montajı',
      weight: 16,
      startFrac: 0.45,
      endFrac: 0.8,
      saha_stage: 'foundation',
      notes: 'String/merkezi inverterler, AG toplama panoları ve beton köşk/trafo/OG hücre montajı',
      defaultTasks: [
        { title: 'İnverter, AC toplama panoları ve trafo köşkü yerleşimi', description: 'OG hücre ve trafo bağlantıları', priority: 'high', frac: 0.85 },
      ],
    },
    {
      code: 'FAZ-05',
      name: 'DC/AC Kablaj, Kanal & Topraklama',
      weight: 18,
      startFrac: 0.5,
      endFrac: 0.9,
      saha_stage: 'stringing',
      notes: 'Solar DC string kabloları, MC4 konnektörler, AC güç kabloları ve eşpotansiyel topraklama',
      defaultTasks: [
        { title: 'DC string kablajı, MC4 konnektör bağlantıları ve Voc/Isc ölçümleri', description: 'String polarite ve izolasyon testleri', priority: 'high', frac: 0.7 },
        { title: 'AC alçak/orta gerilim kablo çekimi ve topraklama ağı', description: 'Kablo kanalları kapatma ve megger testleri', priority: 'high', frac: 0.92 },
      ],
    },
    {
      code: 'FAZ-06',
      name: 'SCADA, Testler & Geçici Kabul',
      weight: 8,
      startFrac: 0.85,
      endFrac: 1.0,
      saha_stage: 'completed',
      notes: 'Veri kayıt (datalogger/meteoroloji), termal kamera kontrolü ve TEDAŞ/dağıtım kabulü',
      defaultTasks: [
        { title: 'İnverter devreye alma, termal kontrol ve Geçici Kabul', description: 'Kabul dosyası ve şebeke senkronizasyonu', priority: 'high', frac: 0.95 },
      ],
    },
  ],
  res: [
    {
      code: 'FAZ-01',
      name: 'Ulaşım Yolları, Vinç Platformları & İzinler',
      weight: 14,
      startFrac: 0.0,
      endFrac: 0.3,
      saha_stage: 'excavation',
      notes: 'Ağır nakliye yolları, kurbağa/vinç platformları ve türbin lokasyon hafriyatı',
      defaultTasks: [
        { title: 'Türbin ulaşım yolları ve ağır vinç kurulum platformlarının inşası', description: 'Geoteknik taşıma gücü ve eğim doğrulaması', priority: 'high', frac: 0.8 },
      ],
    },
    {
      code: 'FAZ-02',
      name: 'Türbin Temel Kazı, Demir & Betonarme',
      weight: 22,
      startFrac: 0.15,
      endFrac: 0.52,
      saha_stage: 'foundation',
      notes: 'Ankraj kafesi (anchor cage) montajı, yoğun donatı, kütle betonu dökümü ve kürleme',
      defaultTasks: [
        { title: 'Türbin ankraj kafesi/flanş terazi ayarı ve temel donatı imalatı', description: 'Milimetrik flanş düzlemsellik kontrolü', priority: 'high', frac: 0.5 },
        { title: 'Türbin temel kütle betonu dökümü, sıcaklık takibi ve dolgu', description: 'Temel topraklama direnci ölçümü', priority: 'high', frac: 0.9 },
      ],
    },
    {
      code: 'FAZ-03',
      name: 'Kule, Nasel & Kanat Montajı',
      weight: 28,
      startFrac: 0.4,
      endFrac: 0.78,
      saha_stage: 'erection',
      notes: 'Kule seksiyonları, nasel, hub ve rotor kanatlarının ağır vinçle montajı',
      defaultTasks: [
        { title: 'Kule seksiyonları, nasel ve kanatların montajı ve cıvata torklama', description: 'Rüzgar penceresi takibi ve mekanik tamamlama', priority: 'high', frac: 0.9 },
      ],
    },
    {
      code: 'FAZ-04',
      name: 'OG Enerji Kablosu & Fiber Optik Çekimi',
      weight: 16,
      startFrac: 0.45,
      endFrac: 0.85,
      saha_stage: 'stringing',
      notes: 'Türbinler arası OG yeraltı kablo/ENH hattı ve fiber optik haberleşme altyapısı',
      defaultTasks: [
        { title: 'Türbinler arası OG kablo ve fiber optik kanal/çekim işleri', description: 'Ek başlıkları ve VLF/OTDR testleri', priority: 'high', frac: 0.85 },
      ],
    },
    {
      code: 'FAZ-05',
      name: 'Şalt / Trafo Merkezi & SCADA Entegrasyonu',
      weight: 12,
      startFrac: 0.55,
      endFrac: 0.92,
      saha_stage: 'fittings',
      notes: 'TM bağlantısı, türbin OG hücreleri ve merkezi güç kontrol (PPC/SCADA) sistemi',
      defaultTasks: [
        { title: 'Trafo merkezi bağlantıları ve SCADA / PPC haberleşme testleri', description: 'Reaktif güç ve frekans tepki testleri', priority: 'high', frac: 0.88 },
      ],
    },
    {
      code: 'FAZ-06',
      name: 'Devreye Alma, Performans Testleri & Kabul',
      weight: 8,
      startFrac: 0.85,
      endFrac: 1.0,
      saha_stage: 'completed',
      notes: 'Soğuk/sıcak devreye alma, deneme işletmesi ve Bakanlık/TEİAŞ geçici kabulü',
      defaultTasks: [
        { title: 'Türbin devreye alma, deneme üretimi ve Geçici Kabul', description: 'Kabul tutanakları ve ticari işletmeye geçiş', priority: 'high', frac: 0.95 },
      ],
    },
  ],
};

function addDaysIso(baseDate: string, days: number): string {
  const dt = new Date(baseDate + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + Math.round(days));
  return dt.toISOString().slice(0, 10);
}

function diffDaysIso(a: string, b: string): number {
  const t1 = new Date(a + 'T00:00:00Z').getTime();
  const t2 = new Date(b + 'T00:00:00Z').getTime();
  return Math.max(1, Math.round((t2 - t1) / 86400000));
}

function windowDate(startDate: string, spanDays: number, frac: number): string {
  return addDaysIso(startDate, Math.max(0, Math.min(spanDays, Math.round(spanDays * frac))));
}

export interface CantonSpan {
  index: number;
  fromNum: number;
  toNum: number;
  fromLabel: string;
  toLabel: string;
  poleCount: number;
}

export interface CrossingItem {
  poleNum: number | null;
  poleLabel: string;
  crossing: string;
}

export interface AutoPlanGroup {
  code: string;
  name: string;
  weight: number;
  planned_start: string;
  planned_end: string;
  segment_from: number | null;
  segment_to: number | null;
  saha_stage: string;
  notes: string;
}

export interface AutoPlanTask {
  group_code: string;
  title: string;
  description: string;
  due_date: string;
  priority: 'low' | 'normal' | 'high';
}

export interface AutoPlanOptions {
  mode?: 'hybrid' | 'phase' | 'canton' | 'segment';
  start_date?: string | null;
  end_date?: string | null;
  segment_size?: number;
  weight_source?: 'template' | 'kesif';
  include_phase_tasks?: boolean;
  include_crossing_tasks?: boolean;
  include_parcel_tasks?: boolean;
  replace_existing?: boolean;
}

/** DTL veya direk listesinden gergi/durdurma kantonlarını çıkarır. */
function detectCantons(
  poles: { idx: number; name: string; meta: any }[],
  dtlRows: any[]
): CantonSpan[] {
  const numbered = poles
    .map((p) => ({
      num: poleNumberFromName(p.name),
      name: p.name,
      func: String(p.meta?.function || '').toUpperCase().trim(),
      ttype: String(p.meta?.tower_type || '').toUpperCase().trim(),
    }))
    .filter((p): p is { num: number; name: string; func: string; ttype: string } => p.num != null)
    .sort((a, b) => a.num - b.num);

  if (numbered.length < 2) return [];

  // DTL satırlarından fonksiyon bilgisini tamamla
  const dtlFuncByNum = new Map<number, string>();
  for (const r of dtlRows || []) {
    const n = poleNumberFromName(String(r?.pole || ''));
    if (n != null && r?.function) {
      dtlFuncByNum.set(n, String(r.function).toUpperCase().trim());
    }
  }

  const isAnchor = (p: { num: number; func: string; ttype: string }, idx: number, arr: typeof numbered) => {
    if (idx === 0 || idx === arr.length - 1) return true;
    const f = p.func || dtlFuncByNum.get(p.num) || '';
    if (['KD', 'KT', 'N', 'D', 'T', 'PORTAL'].includes(f)) return true;
    if (/^(?:PB|PC|PD|PE|PF|2FS|2FN)/.test(p.ttype) && f !== 'A' && f !== 'T') return true;
    return false;
  };

  const anchors = numbered.filter((p, idx, arr) => isAnchor(p, idx, arr));
  if (anchors.length < 2) return [];

  const cantons: CantonSpan[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (b.num <= a.num) continue;
    const count = numbered.filter((x) => x.num >= a.num && x.num <= b.num).length;
    cantons.push({
      index: cantons.length + 1,
      fromNum: a.num,
      toNum: b.num,
      fromLabel: `D-${a.num}`,
      toLabel: `D-${b.num}`,
      poleCount: count,
    });
  }
  return cantons;
}

/** Eşit büyüklükte direk kesimleri üretir (ör. 20'şer direk). */
function buildEqualSegments(minNum: number, maxNum: number, segmentSize: number): CantonSpan[] {
  const size = Math.max(5, Math.min(200, Math.round(segmentSize) || 20));
  const out: CantonSpan[] = [];
  let cur = minNum;
  while (cur <= maxNum) {
    const end = Math.min(maxNum, cur + size - 1);
    // Son kalan parça çok küçükse (≤3 direk) bir önceki kesime birleştir
    if (out.length > 0 && maxNum - cur + 1 <= 3) {
      out[out.length - 1].toNum = maxNum;
      out[out.length - 1].toLabel = `D-${maxNum}`;
      out[out.length - 1].poleCount = out[out.length - 1].toNum - out[out.length - 1].fromNum + 1;
      break;
    }
    out.push({
      index: out.length + 1,
      fromNum: cur,
      toNum: end,
      fromLabel: `D-${cur}`,
      toLabel: `D-${end}`,
      poleCount: end - cur + 1,
    });
    cur = end + 1;
  }
  return out;
}

/** DTL ve direk metasından önemli geçişleri (E.İ.H., Yol, Demiryolu, Doğalgaz vb.) çıkarır. */
function detectCrossings(poles: { idx: number; name: string; meta: any }[], dtlRows: any[]): CrossingItem[] {
  const byPole = new Map<string, CrossingItem>();
  for (const r of dtlRows || []) {
    const cr = String(r?.crossing || '').trim();
    if (!cr) continue;
    const num = poleNumberFromName(String(r?.pole || ''));
    const label = num != null ? `D-${num}` : String(r?.pole || 'Direk').trim();
    byPole.set(label, { poleNum: num, poleLabel: label, crossing: cr });
  }
  for (const p of poles) {
    const cr = String(p.meta?.crossing || '').trim();
    if (!cr) continue;
    const num = poleNumberFromName(p.name);
    const label = num != null ? `D-${num}` : p.name;
    if (!byPole.has(label)) {
      byPole.set(label, { poleNum: num, poleLabel: label, crossing: cr });
    }
  }
  return [...byPole.values()].sort((a, b) => (a.poleNum ?? 9999) - (b.poleNum ?? 9999));
}

/** Keşif (BOQ) kalemlerinde birim fiyat girilmişse faz ağırlıklarını maliyet paylarıyla harmanlar. */
function applyKesifWeights(phases: PhaseTemplate[], kesifItems: any[]): number[] {
  const baseWeights = phases.map((p) => p.weight);
  const priced = (kesifItems || []).filter((it) => Number(it.qty) > 0 && Number(it.unit_price) > 0);
  if (priced.length === 0 || phases.length !== 7) return baseWeights;

  let towerCost = 0;
  let condCost = 0;
  let insCost = 0;
  for (const it of priced) {
    const amt = Number(it.qty) * Number(it.unit_price);
    const n = String(it.item_name || '').toLowerCase();
    if (n.includes('direk') || n.includes('portal')) towerCost += amt;
    else if (n.includes('iletken') || n.includes('koruma') || n.includes('opgw')) condCost += amt;
    else if (n.includes('izolat') || n.includes('hırdavat') || n.includes('klem')) insCost += amt;
  }
  const matTotal = towerCost + condCost + insCost;
  if (matTotal <= 0) return baseWeights;

  // Etüt (%8) ve Test/Kabul (%7) sabit tutulup kalan %85 keşif oranlarıyla harmanlanır
  const towerShare = towerCost / matTotal; // Kazı + Temel + Montaj
  const insShare = insCost / matTotal;
  const condShare = condCost / matTotal;

  const erectTotal = Math.max(35, Math.min(65, Math.round(85 * (0.5 * towerShare + 0.5 * (55 / 85)))));
  const wKazi = Math.max(8, Math.round(erectTotal * 0.27));
  const wTemel = Math.max(10, Math.round(erectTotal * 0.33));
  const wMontaj = Math.max(12, erectTotal - wKazi - wTemel);
  const rem = 85 - (wKazi + wTemel + wMontaj);
  const wIzol = Math.max(6, Math.min(18, Math.round(rem * (0.5 * (insShare / Math.max(0.05, insShare + condShare)) + 0.5 * (10 / 30)))));
  const wTel = Math.max(10, rem - wIzol);

  return [8, wKazi, wTemel, wMontaj, wIzol, wTel, 100 - (8 + wKazi + wTemel + wMontaj + wIzol + wTel)];
}

export async function buildAutoPlanPreview(projectId: number, opts: AutoPlanOptions = {}) {
  const projRes = await pool.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (projRes.rowCount === 0) throw new Error('Proje bulunamadı.');
  const proj = projRes.rows[0];

  const [polesRes, dtlRes, kesifRes, parcelsRes, existingWgRes] = await Promise.all([
    pool.query('SELECT idx, name, meta FROM poles WHERE project_id = $1 ORDER BY idx', [projectId]),
    pool.query('SELECT header, rows FROM project_dtl WHERE project_id = $1', [projectId]),
    pool.query('SELECT item_name, unit, qty, unit_price FROM kesif_items WHERE project_id = $1 ORDER BY position, id', [projectId]),
    pool.query(
      `SELECT p.*, pf.name AS from_name, pt.name AS to_name
       FROM parcels p
       LEFT JOIN poles pf ON pf.project_id = p.project_id AND pf.idx = p.pole_from_idx
       LEFT JOIN poles pt ON pt.project_id = p.project_id AND pt.idx = p.pole_to_idx
       WHERE p.project_id = $1 AND p.easement_status IN ('izinsiz', 'basvuruda')
       ORDER BY p.pole_from_idx`,
      [projectId]
    ),
    pool.query('SELECT COUNT(*)::int AS c FROM work_groups WHERE project_id = $1', [projectId]),
  ]);

  const poles = polesRes.rows;
  const dtlRows: any[] = Array.isArray(dtlRes.rows[0]?.rows) ? dtlRes.rows[0].rows : [];
  const kesifItems = kesifRes.rows;
  const unpermittedParcels = parcelsRes.rows;

  const poleNums = poles.map((p: any) => poleNumberFromName(p.name)).filter((n): n is number => n != null);
  const minPole = poleNums.length > 0 ? Math.min(...poleNums) : null;
  const maxPole = poleNums.length > 0 ? Math.max(...poleNums) : null;

  const todayIso = new Date().toISOString().slice(0, 10);
  const startDate = opts.start_date || proj.start_date || todayIso;
  const rawEnd = opts.end_date || proj.end_date || addDaysIso(startDate, 180);
  const endDate = rawEnd > startDate ? rawEnd : addDaysIso(startDate, 180);
  const spanDays = diffDaysIso(startDate, endDate);

  const projectType = PHASE_TEMPLATES[proj.type] ? proj.type : 'enh';
  const templates = PHASE_TEMPLATES[projectType];
  const cantons = detectCantons(poles, dtlRows);
  const segmentSize = Math.max(5, Math.min(200, Number(opts.segment_size) || 20));
  const equalSegments = minPole != null && maxPole != null ? buildEqualSegments(minPole, maxPole, segmentSize) : [];
  const crossings = detectCrossings(poles, dtlRows);
  const kesifPricedCount = kesifItems.filter((it: any) => Number(it.qty) > 0 && Number(it.unit_price) > 0).length;

  const mode = opts.mode || 'hybrid';
  const includePhaseTasks = opts.include_phase_tasks !== false;
  const includeCrossingTasks = opts.include_crossing_tasks !== false;
  const includeParcelTasks = opts.include_parcel_tasks !== false;
  const weights = opts.weight_source === 'kesif' ? applyKesifWeights(templates, kesifItems) : templates.map((t) => t.weight);

  const groups: AutoPlanGroup[] = [];
  const tasks: AutoPlanTask[] = [];

  if (mode === 'canton' && (cantons.length >= 2 || equalSegments.length >= 2)) {
    const spans = cantons.length >= 2 ? cantons : equalSegments;
    const totalPolesInSpans = spans.reduce((s, c) => s + c.poleCount, 0) || 1;
    let weightSum = 0;
    spans.forEach((c, idx) => {
      const code = `KNT-${String(c.index).padStart(2, '0')}`;
      const isLast = idx === spans.length - 1;
      const w = isLast
        ? Math.max(1, Math.round((100 - weightSum) * 10) / 10)
        : Math.max(1, Math.round((c.poleCount / totalPolesInSpans) * 1000) / 10);
      weightSum += w;
      const startFrac = (idx / spans.length) * 0.65;
      const endFrac = Math.min(1, startFrac + 0.35 + (1 / spans.length) * 0.3);
      const ps = windowDate(startDate, spanDays, startFrac);
      const pe = windowDate(startDate, spanDays, endFrac);
      groups.push({
        code,
        name: `${c.index}. Gergi Kantonu (${c.fromLabel} → ${c.toLabel})`,
        weight: w,
        planned_start: ps,
        planned_end: pe,
        segment_from: c.fromNum,
        segment_to: c.toNum,
        saha_stage: 'all',
        notes: `${c.poleCount} direk · kazı, temel, montaj ve iletken çekimi`,
      });
      if (includePhaseTasks) {
        const subSpan = diffDaysIso(ps, pe);
        tasks.push(
          {
            group_code: code,
            title: `${c.fromLabel}–${c.toLabel} Temel Kazı & Betonarme Tamamlama`,
            description: `${c.poleCount} direklik kantonda temel kazı ve beton dökümü`,
            due_date: windowDate(ps, subSpan, 0.4),
            priority: 'normal',
          },
          {
            group_code: code,
            title: `${c.fromLabel}–${c.toLabel} Direk Dikimi & İzolatör Montajı`,
            description: `${c.poleCount} direğin montajı, torklama ve makara asımı`,
            due_date: windowDate(ps, subSpan, 0.75),
            priority: 'normal',
          },
          {
            group_code: code,
            title: `${c.fromLabel}–${c.toLabel} İletken Çekimi & Sehim Ayarı`,
            description: `Gergi aralığında tel çekimi, sehim ve klemp bağlantıları`,
            due_date: windowDate(ps, subSpan, 0.95),
            priority: 'high',
          }
        );
      }
    });
  } else if (mode === 'segment' && equalSegments.length >= 1) {
    const spans = equalSegments;
    const totalPolesInSpans = spans.reduce((s, c) => s + c.poleCount, 0) || 1;
    let weightSum = 0;
    spans.forEach((c, idx) => {
      const code = `KSM-${String(c.index).padStart(2, '0')}`;
      const isLast = idx === spans.length - 1;
      const w = isLast
        ? Math.max(1, Math.round((100 - weightSum) * 10) / 10)
        : Math.max(1, Math.round((c.poleCount / totalPolesInSpans) * 1000) / 10);
      weightSum += w;
      const startFrac = (idx / spans.length) * 0.6;
      const endFrac = Math.min(1, startFrac + 0.4 + (1 / spans.length) * 0.25);
      const ps = windowDate(startDate, spanDays, startFrac);
      const pe = windowDate(startDate, spanDays, endFrac);
      groups.push({
        code,
        name: `${c.index}. Ekip Kesimi (${c.fromLabel} → ${c.toLabel})`,
        weight: w,
        planned_start: ps,
        planned_end: pe,
        segment_from: c.fromNum,
        segment_to: c.toNum,
        saha_stage: 'all',
        notes: `${c.poleCount} direk · ekip bazlı saha ilerleme takibi`,
      });
      if (includePhaseTasks) {
        const subSpan = diffDaysIso(ps, pe);
        tasks.push(
          {
            group_code: code,
            title: `${c.fromLabel}–${c.toLabel} Kazı ve Temel Betonu`,
            description: `${c.poleCount} direk temel imalatı`,
            due_date: windowDate(ps, subSpan, 0.4),
            priority: 'normal',
          },
          {
            group_code: code,
            title: `${c.fromLabel}–${c.toLabel} Direk Montajı ve Donanım`,
            description: `${c.poleCount} direk dikimi ve izolatör montajı`,
            due_date: windowDate(ps, subSpan, 0.75),
            priority: 'normal',
          },
          {
            group_code: code,
            title: `${c.fromLabel}–${c.toLabel} İletken Çekimi ve Tamamlama`,
            description: `${c.fromLabel}–${c.toLabel} kesimi tel çekimi ve kabul hazırlığı`,
            due_date: windowDate(ps, subSpan, 0.95),
            priority: 'high',
          }
        );
      }
    });
  } else {
    // 'hybrid' veya 'phase' modu: Faz bazlı iş grupları
    templates.forEach((tpl, idx) => {
      const ps = windowDate(startDate, spanDays, tpl.startFrac);
      const pe = windowDate(startDate, spanDays, tpl.endFrac);
      const w = weights[idx] ?? tpl.weight;
      groups.push({
        code: tpl.code,
        name: tpl.name,
        weight: w,
        planned_start: ps,
        planned_end: pe,
        segment_from: minPole,
        segment_to: maxPole,
        saha_stage: tpl.saha_stage,
        notes: tpl.notes,
      });

      if (includePhaseTasks) {
        const subSpan = diffDaysIso(ps, pe);
        for (const dt of tpl.defaultTasks) {
          tasks.push({
            group_code: tpl.code,
            title: dt.title,
            description: dt.description,
            due_date: windowDate(ps, subSpan, dt.frac),
            priority: dt.priority,
          });
        }

        // Hibrit modda ENH projelerinde kanton/kesim bazlı saha görevlerini ilgili imalat fazlarına dağıt
        if (mode === 'hybrid' && projectType === 'enh') {
          const activeSpans = cantons.length >= 2 ? cantons : equalSegments;
          if (activeSpans.length >= 2) {
            if (tpl.saha_stage === 'foundation') {
              activeSpans.forEach((c, cIdx) => {
                tasks.push({
                  group_code: tpl.code,
                  title: `Bölge ${c.index} (${c.fromLabel}→${c.toLabel}) Temel & Ankraj Tamamlama`,
                  description: `${c.poleCount} direklik kesimde temel betonu ve topraklama kontrolü`,
                  due_date: windowDate(ps, subSpan, 0.3 + ((cIdx + 1) / activeSpans.length) * 0.65),
                  priority: 'normal',
                });
              });
            } else if (tpl.saha_stage === 'erection') {
              activeSpans.forEach((c, cIdx) => {
                tasks.push({
                  group_code: tpl.code,
                  title: `Bölge ${c.index} (${c.fromLabel}→${c.toLabel}) Direk Montajı (${c.poleCount} direk)`,
                  description: `${c.fromLabel}–${c.toLabel} arası direk dikimi, şakül ve tork kontrolü`,
                  due_date: windowDate(ps, subSpan, 0.25 + ((cIdx + 1) / activeSpans.length) * 0.7),
                  priority: 'normal',
                });
              });
            } else if (tpl.saha_stage === 'stringing') {
              activeSpans.forEach((c, cIdx) => {
                tasks.push({
                  group_code: tpl.code,
                  title: `Kanton ${c.index} (${c.fromLabel}→${c.toLabel}) İletken Çekimi & Sehim`,
                  description: `${c.fromLabel}–${c.toLabel} gergi aralığında 3 faz iletken + koruma teli çekimi`,
                  due_date: windowDate(ps, subSpan, 0.2 + ((cIdx + 1) / activeSpans.length) * 0.75),
                  priority: 'high',
                });
              });
            }
          }
        }
      }
    });
  }

  // DTL özel geçiş görevleri (E.İ.H., Karayolu, Demiryolu, Doğalgaz vb.)
  if (includeCrossingTasks && crossings.length > 0 && groups.length > 0) {
    const targetGroup =
      groups.find((g) => g.saha_stage === 'stringing') ||
      groups[0];
    for (const cr of crossings.slice(0, 25)) {
      const targetBySeg =
        cr.poleNum != null
          ? groups.find(
              (g) =>
                g.segment_from != null &&
                g.segment_to != null &&
                !(g.segment_from === minPole && g.segment_to === maxPole) &&
                cr.poleNum! >= g.segment_from &&
                cr.poleNum! <= g.segment_to
            )
          : null;
      const g = targetBySeg || targetGroup;
      const isCritical = /E\.İ\.H|KV|DEMİR|DOĞALGAZ|ASFALT/i.test(cr.crossing);
      tasks.push({
        group_code: g.code,
        title: `${cr.poleLabel} Geçiş İzni & Güvenlik Tedbiri: ${cr.crossing}`,
        description: `${cr.poleLabel} direği açıklığında (${cr.crossing}) kurum koordinasyonu, enerji kesintisi / koruma iskelesi önlemi`,
        due_date: g.planned_start,
        priority: isCritical ? 'high' : 'normal',
      });
    }
  }

  // Kamulaştırma / izinsiz parsel görevleri
  if (includeParcelTasks && unpermittedParcels.length > 0 && groups.length > 0) {
    const firstGroup = groups[0];
    for (const par of unpermittedParcels.slice(0, 20)) {
      const spanLabel = `${par.from_name || 'D-' + (par.pole_from_idx + 1)} → ${par.to_name || 'D-' + (par.pole_to_idx + 1)}`;
      tasks.push({
        group_code: firstGroup.code,
        title: `Kamulaştırma / İzin Çözümü: ${spanLabel}${par.parcel_no ? ` (Parsel ${par.parcel_no})` : ''}`,
        description: `Malik: ${par.owner_name || 'Belirtilmedi'} · Durum: ${par.easement_status === 'izinsiz' ? 'İzinsiz (Kazı öncesi çözülmeli)' : 'Başvuruda'}`,
        due_date: firstGroup.planned_end,
        priority: par.easement_status === 'izinsiz' ? 'high' : 'normal',
      });
    }
  }

  return {
    stats: {
      project_id: projectId,
      project_name: proj.name,
      project_type: projectType,
      pole_count: poles.length,
      min_pole: minPole,
      max_pole: maxPole,
      dtl_row_count: dtlRows.length,
      canton_count: cantons.length,
      segment_count: equalSegments.length,
      crossing_count: crossings.length,
      unpermitted_parcel_count: unpermittedParcels.length,
      kesif_priced_count: kesifPricedCount,
      existing_group_count: existingWgRes.rows[0].c,
    },
    resolved_dates: {
      start_date: startDate,
      end_date: endDate,
      span_days: spanDays,
    },
    groups,
    tasks,
  };
}

/**
 * Projedeki iş gruplarının saha ilerlemesini (`saha_progress`) hesaplar;
 * `persist = true` ise `work_groups.progress` ve `work_groups.status` sütunlarını günceller.
 */
export async function syncWorkGroupsFromSaha(
  projectId: number,
  persist = true,
  dbClient?: Pool | PoolClient
): Promise<{ updated: number; groups: { id: number; code: string; saha_progress: number | null }[] }> {
  const q = dbClient || pool;
  const [wgRes, polesRes] = await Promise.all([
    q.query('SELECT id, code, segment_from, segment_to, saha_stage, progress, status FROM work_groups WHERE project_id = $1 ORDER BY code', [
      projectId,
    ]),
    q.query(
      `SELECT p.name, COALESCE(s.status, 'none') AS st
       FROM poles p
       LEFT JOIN pole_status s ON s.project_id = p.project_id AND s.pole_idx = p.idx
       WHERE p.project_id = $1`,
      [projectId]
    ),
  ]);

  const poles = polesRes.rows.map((p: any) => ({
    num: poleNumberFromName(p.name),
    st: String(p.st || 'none'),
  }));

  let updated = 0;
  const out: { id: number; code: string; saha_progress: number | null }[] = [];

  for (const g of wgRes.rows) {
    if (poles.length === 0) {
      out.push({ id: g.id, code: g.code, saha_progress: null });
      continue;
    }
    const targetPoles =
      g.segment_from != null && g.segment_to != null
        ? poles.filter((x) => x.num != null && x.num >= g.segment_from && x.num <= g.segment_to)
        : poles;

    if (targetPoles.length === 0) {
      out.push({ id: g.id, code: g.code, saha_progress: null });
      continue;
    }

    const stg = String(g.saha_stage || '').trim();
    const sum = targetPoles.reduce((acc, p) => acc + poleStageProgress(p.st, stg), 0);
    const sahaProg = Math.round((sum / targetPoles.length) * 10) / 10;
    out.push({ id: g.id, code: g.code, saha_progress: sahaProg });

    // Persist yalnızca saha aşaması veya direk kesimi tanımlı gruplarda (veya açıkça çağrıldığında)
    if (persist && (stg !== '' || (g.segment_from != null && g.segment_to != null))) {
      const nextStatus = sahaProg >= 100 ? 'completed' : sahaProg > 0 ? 'active' : 'pending';
      if (Number(g.progress) !== sahaProg || g.status !== nextStatus) {
        await q.query('UPDATE work_groups SET progress = $1, status = $2 WHERE id = $3', [sahaProg, nextStatus, g.id]);
        updated++;
      }
    }
  }

  return { updated, groups: out };
}
