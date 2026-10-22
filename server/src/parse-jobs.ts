// Bellek içi asenkron iş kuyruğu.
//
// Panel proxy'si ~60-70 sn'den uzun HTTP isteklerini sessizce keser (200 + boş gövde);
// OCR gibi dakikalar süren işler bu yüzden 202 + iş kimliği modeliyle yürütülür:
// istek anında kuyruğa girer, istemci GET /job/:id ile yoklar.
//
// Kuyruk SERİ çalışır: OCR servisi 1-eşzamanlılık üzerine kurulu
// (OLLAMA_NUM_PARALLEL=1; paralel OCR çağrıları llama-server'ı düşürüyordu).
import crypto from 'crypto';

export interface ParseJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: string;
  started_at: number;
  finished_at: number | null;
  result?: unknown;
  error?: string;
}

const jobs = new Map<string, ParseJob>();
let chain: Promise<void> = Promise.resolve();

export function runJob(label: string, fn: (report: (p: string) => void) => Promise<unknown>): ParseJob {
  const job: ParseJob = {
    id: crypto.randomUUID(),
    status: 'queued',
    progress: label,
    started_at: Date.now(),
    finished_at: null,
  };
  jobs.set(job.id, job);
  chain = chain.then(async () => {
    job.status = 'running';
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
    }
  });
  return job;
}

export function getJob(id: string): ParseJob | undefined {
  return jobs.get(id);
}

// Eskiyen işleri temizle (bitmiş + 45 dk) — süreçten bağımsız, kuyruğu tıkamaz
setInterval(() => {
  const cutoff = Date.now() - 45 * 60 * 1000;
  for (const [id, j] of jobs) {
    if (j.finished_at != null && j.finished_at < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();
