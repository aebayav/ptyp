// Python OCR servisi (FastAPI + GLM-OCR) istemcisi
import http from 'http';
import https from 'https';
import { DtlHeader, DtlRow } from './dtl-parser';

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
  dtl_rows?: DtlRow[];
}

export interface OcrResponse {
  pages: OcrPage[];
  pages_count: number;
  dtl_header?: DtlHeader;
  dtl_rows?: DtlRow[];
}

export interface OcrPreviewResponse {
  preview: string;
  width: number;
  height: number;
  pages_count: number;
  auto_rotation: number;
}

function postMultipart<T>(endpointPath: string, buffer: Buffer, filename: string, timeoutMs: number): Promise<T> {
  const boundary = '----PtypOcrBoundary' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const safeName = (filename || 'document.pdf').replace(/["\r\n]/g, '_');
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    'utf8'
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([header, buffer, footer]);

  const url = new URL(`${OCR_URL}${endpointPath}`);
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise<T>((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json: any = {};
          try {
            json = JSON.parse(raw);
          } catch {
            /* ignore */
          }
          if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
            return reject(new Error(json.error || `OCR servisi hata döndü (HTTP ${res.statusCode})`));
          }
          resolve(json as T);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('OCR servisi zaman aşımına uğradı.'));
    });

    req.on('error', (err: any) => {
      if (String(err?.message || '').includes('zaman aşımına')) {
        reject(err);
      } else {
        reject(new Error('OCR servisine ulaşılamadı: ' + (err?.message || err)));
      }
    });

    req.write(body);
    req.end();
  });
}

export async function callOcr(buffer: Buffer, filename: string, rotate: string = 'auto'): Promise<OcrResponse> {
  // Node 22 yerleşik fetch (undici) varsayılan olarak 300 sn headersTimeout uygular;
  // çok sayfalı PDF'lerde 5 dakikayı aşan OCR işlemlerinde "fetch failed" hatasını
  // önlemek için doğrudan http.request (20 dk zaman aşımı) kullanılır.
  const rot = ['0', '90', '180', '270', 'auto'].includes(rotate) ? rotate : 'auto';
  return postMultipart<OcrResponse>(`/ocr/document?rotate=${encodeURIComponent(rot)}`, buffer, filename, 20 * 60 * 1000);
}

export async function callOcrPreview(buffer: Buffer, filename: string): Promise<OcrPreviewResponse> {
  return postMultipart<OcrPreviewResponse>('/ocr/preview', buffer, filename, 30 * 1000);
}
