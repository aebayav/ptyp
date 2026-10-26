// Plan & gerçekleşme: ağırlıklı ilerleme + planlanan tarihlerden otomatik
// S-eğrisi ve gecikme uyarısı. Tarihsel günlük ilerleme tutulmadığı için
// gerçekleşen eğri "başlangıç → bugünkü ağırlıklı ilerleme" doğrusudur;
// planlanan eğri ise her iş grubunun ağırlığı plan aralığına eşit dağıtılarak üretilir.
import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';

const router = Router();
router.use(requireAuth, requireRole('owner'));

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function addDays(d: string, n: number): string {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().slice(0, 10);
}

router.get('/', async (req: Request, res: Response) => {
  const pid = Number(req.query.project_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });

  const { rows } = await pool.query(
    `SELECT id, code, name, weight, progress, planned_start, planned_end, status
     FROM work_groups WHERE project_id = $1 AND weight > 0 ORDER BY planned_start NULLS LAST, code`,
    [pid]
  );

  if (rows.length === 0) {
    return res.json({ groups: [], curve: { dates: [], planned: [], actual: [] }, summary: null });
  }

  const today = new Date().toISOString().slice(0, 10);
  const totalWeight = rows.reduce((s: number, g: any) => s + Number(g.weight), 0) || 1;

  // Tarih aralığı: en erken plan başlangıcı → en geç (plan bitişi | bugün)
  const starts = rows.map((g: any) => g.planned_start).filter(Boolean).sort();
  const ends = rows
    .map((g: any) => (g.planned_end && g.planned_end > today ? g.planned_end : today))
    .filter(Boolean)
    .sort();
  const from = starts[0] || today;
  const to = ends[ends.length - 1] || today;
  const spanDays = Math.max(1, daysBetween(from, to));

  // Her grup için günlük plan katkısı (ağırlık / süre)
  const groups = rows.map((g: any) => {
    const weight = Number(g.weight);
    const progress = Number(g.progress);
    const ps = g.planned_start;
    const pe = g.planned_end;
    const duration = ps && pe && pe > ps ? daysBetween(ps, pe) : null;
    const late = pe && pe < today && progress < 100;
    const delayDays = late && pe ? daysBetween(pe, today) : 0;
    // Bugün itibarıyla planlanmış ilerleme (grubun kendi planına göre)
    let plannedNowPct = 0;
    if (ps && pe && pe > ps) {
      if (today >= pe) plannedNowPct = 100;
      else if (today <= ps) plannedNowPct = 0;
      else plannedNowPct = (daysBetween(ps, today) / daysBetween(ps, pe)) * 100;
    }
    return {
      id: g.id,
      code: g.code,
      name: g.name,
      weight,
      progress,
      planned_start: ps,
      planned_end: pe,
      duration,
      late,
      delay_days: delayDays,
      planned_now_pct: Math.round(plannedNowPct * 10) / 10,
      behind_pct: Math.max(0, Math.round((plannedNowPct - progress) * 10) / 10),
    };
  });

  // Eğri noktaları (günlük)
  const dates: string[] = [];
  const planned: number[] = [];
  const actual: number[] = [];
  for (let d = 0; d <= spanDays; d++) {
    const date = addDays(from, d);
    dates.push(date);
    let cum = 0;
    for (const g of groups) {
      if (g.duration == null) continue;
      const gStart = g.planned_start as string;
      const gEnd = g.planned_end as string;
      if (date < gStart) continue;
      const done = date >= gEnd ? 1 : daysBetween(gStart, date) / (g.duration as number);
      cum += g.weight * Math.min(1, Math.max(0, done));
    }
    planned.push(Math.round((cum / totalWeight) * 1000) / 10);
    // Gerçekleşen: bugüne kadar doğrusal yükseliş varsayımı, bugünden sonra düz
    if (date <= today) {
      const frac = daysBetween(from, date) / Math.max(1, daysBetween(from, today));
      const actualToday = groups.reduce((s: number, g: any) => s + (g.weight * g.progress) / 100, 0) / totalWeight * 100;
      actual.push(Math.round(actualToday * frac * 10) / 10);
    } else {
      const actualToday = groups.reduce((s: number, g: any) => s + (g.weight * g.progress) / 100, 0) / totalWeight * 100;
      actual.push(Math.round(actualToday * 10) / 10);
    }
  }

  const actualToday = groups.reduce((s: number, g: any) => s + (g.weight * g.progress) / 100, 0) / totalWeight * 100;
  const plannedToday =
    planned[Math.min(dates.indexOf(today) >= 0 ? dates.indexOf(today) : dates.length - 1, dates.length - 1)] ?? 0;

  res.json({
    groups,
    curve: { dates, planned, actual },
    summary: {
      total_weight: Math.round(totalWeight * 100) / 100,
      actual_pct: Math.round(actualToday * 10) / 10,
      planned_pct: Math.round(plannedToday * 10) / 10,
      behind_pct: Math.round(Math.max(0, plannedToday - actualToday) * 10) / 10,
      late_groups: groups.filter((g: any) => g.late).length,
      today,
    },
  });
});

export default router;
