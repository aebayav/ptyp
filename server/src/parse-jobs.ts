// Bellek içi asenkron iş kuyruğu + kalıcılık (parse_jobs tablosu).
//
// Panel proxy'si ~60-70 sn'den uzun HTTP isteklerini sessizce keser (200 + boş gövde);
// OCR gibi dakikalar süren işler bu yüzden 202 + iş kimliği modeliyle yürütülür:
// istek anında kuyruğa girer, istemci GET /job/:id ile yoklar.
//
// Kuyruk SERİ çalışır: OCR servisi 1-eşzamanlılık üzerine kurulu
// (OLLAMA_NUM_PARALLEL=1; paralel OCR çağrıları llama-server'ı düşürüyordu).
//
// İşler parse_jobs tablosuna yazılır: sunucu yeniden başlasa da sonuç kaybolmaz;
// yarım kalan işler açılışta 'error' olarak kapatılır (initParseJobs).
import crypto from 'crypto';
import type { Pool } from 'pg';

export interface ParseJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: string;
  started_at: number;
  finished_at: number | null;
  result?: unknown;
  error?: string;
}

let pool: Pool | null = null;

/** Açılışta çağrılır: yarım kalan işleri kapatır, DB bağlantısını kurar. */
export function initParseJobs(p: Pool): void {
  pool = p;
  p.query(
    `UPDATE parse_jobs SET status = 'error',
       error = 'Sunucu yeniden başladı — iş tamamlanamadı.', finished_at = now()
     WHERE status IN ('queued', 'running')`
  ).catch(() => {});
}

const jobs = new Map<string, ParseJob>();
let chain: Promise<void> = Promise.resolve();

function dbJobUpdate(job: ParseJob): void {
  if (!pool) return;
  pool
    .query(
      `UPDATE parse_jobs SET status = $1, progress = $2, result = $3, error = $4,
         started_at = to_timestamp($5 / 1000.0), finished_at = to_timestamp($6 / 1000.0)
       WHERE id = $7`,
      [
        job.status,
        job.progress,
        job.result != null ? JSON.stringify(job.result) : null,
        job.error ?? null,
        job.started_at / 1000,
        job.finished_at != null ? job.finished_at / 1000 : null,
        job.id,
      ]
    )
    .catch(() => {});
}

export function runJob(label: string, fn: (report: (p: string) => void) => Promise<unknown>): ParseJob {
  const job: ParseJob = {
    id: crypto.randomUUID(),
    status: 'queued',
    progress: label,
    started_at: Date.now(),
    finished_at: null,
  };
  jobs.set(job.id, job);
  if (pool) {
    pool
      .query(
        `INSERT INTO parse_jobs (id, status, progress, created_at)
         VALUES ($1, 'queued', $2, now())`,
        [job.id, label]
      )
      .catch(() => {});
  }
  chain = chain.then(async () => {
    job.status = 'running';
    dbJobUpdate(job);
    try {
      job.result = await fn((p) => {
        job.progress = p;
      });
      job.status = 'done';
    } catch (e: any) {
      job.status = 'error';
      job.error = e?.message || 'Bilinmeyen hata';
    } finally {
      job.finished_at = Date.now();
      dbJobUpdate(job);
    }
  });
  return job;
}

/** Bellekte yoksa DB'den döner (restart sonrası sonuçlar erişilebilir kalır). */
export async function getJob(id: string): Promise<ParseJob | null> {
  const m = jobs.get(id);
  if (m) return m;
  if (!pool) return null;
  const r = await pool.query('SELECT * FROM parse_jobs WHERE id = $1', [id]);
  if ((r.rowCount ?? 0) === 0) return null;
  const row = r.rows[0];
  const createdMs = row.created_at ? new Date(row.created_at).getTime() : Date.now();
  return {
    id: String(row.id),
    status: row.status,
    progress: row.progress || '',
    started_at: row.started_at ? new Date(row.started_at).getTime() : createdMs,
    finished_at: row.finished_at ? new Date(row.finished_at).getTime() : null,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
  };
}

// Eskiyen işleri temizle (bitmiş + 45 dk) — hem bellekten hem DB'den
setInterval(() => {
  const cutoff = Date.now() - 45 * 60 * 1000;
  for (const [id, j] of jobs) {
    if (j.finished_at != null && j.finished_at < cutoff) jobs.delete(id);
  }
  if (pool) {
    pool.query(`DELETE FROM parse_jobs WHERE finished_at < now() - interval '45 minutes'`).catch(() => {});
  }
}, 10 * 60 * 1000).unref();
