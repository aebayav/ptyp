// Portföy genel bakış: /overview/portfolio endpoint'inin saf toplama mantığı.
// DB'den gelen grup satırları girer; sıralı portföy özeti çıkar (DB'siz birim test edilir).
// Ağırlıklı ilerleme formülü overview.ts ile aynı: SUM(progress×weight)/SUM(weight),
// progress 0-100 ölçeğinde; weight toplamı 0 olan projede AVG(progress) kullanılır.

export interface ProjectLike {
  id: number;
  name: string;
  type: string;
  capacity: string;
  employer: string;
  end_date: string;
}

export interface WeightedRow {
  project_id: number;
  num: number; // SUM(progress * weight)
  den: number; // SUM(weight)
  avg_progress: number; // AVG(progress) — den 0 iken fallback
}

export interface SahaRow {
  project_id: number;
  num: number; // aşama ağırlıklarıyla toplam (tüm direk "tamam" = cnt×100)
  cnt: number; // direk sayısı
}

export interface CountRow {
  project_id: number;
  c: number;
}

export interface PaymentRow {
  project_id: number;
  status: 'draft' | 'submitted' | 'approved';
  c: number;
  total: number;
}

export interface BuildPortfolioInput {
  projects: ProjectLike[];
  weighted: WeightedRow[];
  saha: SahaRow[];
  lateTasks: CountRow[];
  parcels: CountRow[];
  expiringCerts: CountRow[];
  openRequests: CountRow[];
  payments: PaymentRow[];
}

export interface PortfolioRow {
  id: number;
  name: string;
  type: string;
  capacity: string;
  employer: string;
  end_date: string;
  progress: number;
  saha_progress: number;
  saha_poles: number;
  payments: { draft: number; submitted: number; approved: number; total_amount: number };
  warnings: {
    late_tasks: number;
    unpermitted_parcels: number;
    expiring_certs: number;
    open_requests: number;
  };
  warning_count: number;
}

export interface PortfolioResponse {
  projects: PortfolioRow[];
  totals: { project_count: number; firm_progress: number; projects_with_warnings: number };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function byProject<T extends { project_id: number }>(rows: T[]): Map<number, T> {
  return new Map(rows.map((r) => [Number(r.project_id), r]));
}

export function buildPortfolio(input: BuildPortfolioInput): PortfolioResponse {
  const weighted = byProject(input.weighted);
  const saha = byProject(input.saha);
  const late = byProject(input.lateTasks);
  const parcels = byProject(input.parcels);
  const certs = byProject(input.expiringCerts);
  const requests = byProject(input.openRequests);

  // Hakediş: (project_id, status) başına birden çok satır gelir — tek yapıda topla
  const payments = new Map<
    number,
    { draft: number; submitted: number; approved: number; total_amount: number }
  >();
  for (const p of input.payments) {
    const pid = Number(p.project_id);
    let entry = payments.get(pid);
    if (!entry) {
      entry = { draft: 0, submitted: 0, approved: 0, total_amount: 0 };
      payments.set(pid, entry);
    }
    if (p.status === 'draft' || p.status === 'submitted' || p.status === 'approved') {
      entry[p.status] += Number(p.c) || 0;
    }
    entry.total_amount += Number(p.total) || 0;
  }

  let numSum = 0;
  let denSum = 0;
  const progressValues: number[] = [];

  const rows: PortfolioRow[] = input.projects.map((proj) => {
    const pid = Number(proj.id);
    const w = weighted.get(pid);
    const s = saha.get(pid);
    const lt = Number(late.get(pid)?.c) || 0;
    const par = Number(parcels.get(pid)?.c) || 0;
    const cert = Number(certs.get(pid)?.c) || 0;
    const req = Number(requests.get(pid)?.c) || 0;

    const den = Number(w?.den) || 0;
    const num = Number(w?.num) || 0;
    let progress: number;
    if (den > 0) {
      progress = round1(num / den);
      numSum += num;
      denSum += den;
    } else {
      progress = round1(Number(w?.avg_progress) || 0);
    }
    progressValues.push(progress);

    const sahaCnt = Number(s?.cnt) || 0;
    const pay = payments.get(pid) || { draft: 0, submitted: 0, approved: 0, total_amount: 0 };
    const warning_count = lt + par + cert + req;

    return {
      id: pid,
      name: proj.name,
      type: proj.type,
      capacity: proj.capacity,
      employer: proj.employer,
      end_date: proj.end_date,
      progress,
      saha_progress: sahaCnt > 0 ? round1((Number(s?.num) || 0) / sahaCnt) : 0,
      saha_poles: sahaCnt,
      payments: pay,
      warnings: {
        late_tasks: lt,
        unpermitted_parcels: par,
        expiring_certs: cert,
        open_requests: req,
      },
      warning_count,
    };
  });

  // Uyarısı çok olan önce; eşitlikte ilerlemesi yüksek olan önce
  rows.sort((a, b) => b.warning_count - a.warning_count || b.progress - a.progress);

  const firm_progress =
    denSum > 0
      ? round1(numSum / denSum)
      : progressValues.length > 0
        ? round1(progressValues.reduce((a, v) => a + v, 0) / progressValues.length)
        : 0;

  return {
    projects: rows,
    totals: {
      project_count: rows.length,
      firm_progress,
      projects_with_warnings: rows.filter((r) => r.warning_count > 0).length,
    },
  };
}
