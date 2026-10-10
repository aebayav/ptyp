// Python OCR servisi (FastAPI + PaddleOCR) istemcisi
const OCR_URL = (process.env.OCR_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

export interface OcrCell {
  text: string;
  conf: number | null;
  fallback?: 'ollama';
}

export interface OcrPage {
  page: number;
  preview: string;
  rows: OcrCell[][];
}

export interface OcrResponse {
  pages: OcrPage[];
  pages_count: number;
}

export async function callOcr(buffer: Buffer, filename: string): Promise<OcrResponse> {
  const fd = new FormData();
  fd.append('file', new Blob([buffer]), filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000); // OCR yavaş olabilir
  try {
    const res = await fetch(`${OCR_URL}/ocr/document`, {
      method: 'POST',
      body: fd,
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new Error(json.error || `OCR servisi hata döndü (HTTP ${res.status})`);
    }
    return json as unknown as OcrResponse;
  } catch (e: any) {
    if (e.name === 'AbortError') throw new Error('OCR servisi zaman aşımına uğradı (10 dk).');
    throw new Error('OCR servisine ulaşılamadı: ' + (e.message || e));
  } finally {
    clearTimeout(timer);
  }
}
