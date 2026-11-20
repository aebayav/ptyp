import { describe, it, expect } from 'vitest';
import { buildPortfolio } from '../src/portfolio-summary';

// buildPortfolio: /overview/portfolio endpoint'inin saf toplama mantığı —
// DB satırları girer, sıralı portföy özeti çıkar (DB'ye ihtiyaç duymaz).

const PROJECT_1 = { id: 1, name: 'DIYAR-2', type: 'enh', capacity: '63 MVA', employer: 'TEİAŞ', end_date: '2027-01-15' };
const PROJECT_2 = { id: 2, name: 'Trafo-X', type: 'trafo', capacity: '', employer: '', end_date: '' };

describe('buildPortfolio', () => {
  it('aggregates all sources into one row per project', () => {
    const r = buildPortfolio({
      projects: [PROJECT_1, PROJECT_2],
      // num = SUM(progress×weight) — progress 0-100 ölçeğinde (overview.ts ile aynı)
      weighted: [{ project_id: 1, num: 7100, den: 100, avg_progress: 40 }],
      saha: [{ project_id: 1, num: 480, cnt: 10 }],
      lateTasks: [{ project_id: 1, c: 2 }],
      parcels: [],
      expiringCerts: [],
      openRequests: [],
      payments: [
        { project_id: 1, status: 'draft', c: 1, total: 4200000 },
        { project_id: 1, status: 'approved', c: 1, total: 0 },
      ],
    });
    expect(r.projects[0].id).toBe(1);
    expect(r.projects[0].progress).toBe(71.0);
    expect(r.projects[0].saha_progress).toBe(48.0);
    expect(r.projects[0].saha_poles).toBe(10);
    expect(r.projects[0].payments).toEqual({ draft: 1, submitted: 0, approved: 1, total_amount: 4200000 });
    expect(r.projects[0].warnings.late_tasks).toBe(2);
    expect(r.projects[0].warning_count).toBe(2);
  });

  it('falls back to AVG(progress) when total weight is zero', () => {
    const r = buildPortfolio({
      projects: [PROJECT_1],
      weighted: [{ project_id: 1, num: 0, den: 0, avg_progress: 33 }],
      saha: [], lateTasks: [], parcels: [], expiringCerts: [], openRequests: [],
      payments: [],
    });
    expect(r.projects[0].progress).toBe(33);
  });

  it('returns zeros (never NaN) for a project with no data anywhere', () => {
    const r = buildPortfolio({
      projects: [PROJECT_1, PROJECT_2],
      weighted: [{ project_id: 1, num: 7100, den: 100, avg_progress: 40 }],
      saha: [{ project_id: 1, num: 480, cnt: 10 }],
      lateTasks: [],
      parcels: [],
      expiringCerts: [],
      openRequests: [],
      payments: [],
    });
    const p2 = r.projects.find((p: any) => p.id === 2)!;
    expect(p2.progress).toBe(0);
    expect(p2.saha_progress).toBe(0);
    expect(p2.saha_poles).toBe(0);
    expect(p2.payments).toEqual({ draft: 0, submitted: 0, approved: 0, total_amount: 0 });
    expect(p2.warnings).toEqual({ late_tasks: 0, unpermitted_parcels: 0, expiring_certs: 0, open_requests: 0 });
    expect(p2.warning_count).toBe(0);
    for (const v of Object.values(p2.warnings)) expect(Number.isFinite(v)).toBe(true);
  });

  it('sorts by warning_count desc, then progress desc on ties', () => {
    const mk = (id: number, name: string) => ({ id, name, type: 'enh', capacity: '', employer: '', end_date: '' });
    const r = buildPortfolio({
      projects: [mk(1, 'p1'), mk(2, 'p2'), mk(3, 'p3')],
      weighted: [
        { project_id: 1, num: 5000, den: 100, avg_progress: 0 },
        { project_id: 2, num: 8000, den: 100, avg_progress: 0 },
      ],
      saha: [],
      lateTasks: [
        { project_id: 1, c: 1 },
        { project_id: 2, c: 1 },
        { project_id: 3, c: 3 },
      ],
      parcels: [],
      expiringCerts: [],
      openRequests: [],
      payments: [],
    });
    expect(r.projects.map((p: any) => p.id)).toEqual([3, 2, 1]);
  });

  it('computes firm-wide weighted progress and projects_with_warnings in totals', () => {
    const mk = (id: number, name: string) => ({ id, name, type: 'enh', capacity: '', employer: '', end_date: '' });
    const r = buildPortfolio({
      projects: [mk(1, 'p1'), mk(2, 'p2')],
      weighted: [
        { project_id: 1, num: 5000, den: 100, avg_progress: 0 },
        { project_id: 2, num: 8000, den: 100, avg_progress: 0 },
      ],
      saha: [],
      lateTasks: [{ project_id: 2, c: 4 }],
      parcels: [],
      expiringCerts: [],
      openRequests: [],
      payments: [],
    });
    expect(r.totals.project_count).toBe(2);
    expect(r.totals.firm_progress).toBe(65.0);
    expect(r.totals.projects_with_warnings).toBe(1);
  });

  it('maps payment statuses to their own counters and sums total_amount across all', () => {
    const r = buildPortfolio({
      projects: [PROJECT_1],
      weighted: [],
      saha: [],
      lateTasks: [],
      parcels: [],
      expiringCerts: [],
      openRequests: [],
      payments: [
        { project_id: 1, status: 'draft', c: 2, total: 100 },
        { project_id: 1, status: 'submitted', c: 1, total: 200 },
        { project_id: 1, status: 'approved', c: 3, total: 300 },
      ],
    });
    expect(r.projects[0].payments).toEqual({ draft: 2, submitted: 1, approved: 3, total_amount: 600 });
  });
});
