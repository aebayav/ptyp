// Belge okuma sistemi — KMZ üretimi için PDF / TIFF / Excel girişleri
//
// Pipeline:
//   PDF  → analiz → metin katmanı VAR  → koordinat parse
//                 → metin katmanı YOK  → taranmış belge (OCR — sonraki adım)
//   TIFF → taranmış görüntü (OCR — sonraki adım)
//   Excel→ doğrudan hücre parse
import path from 'path';
import pdfParse from 'pdf-parse';

export type DocumentKind = 'pdf' | 'tiff' | 'excel' | 'unknown';

export interface PdfAnalysis {
  hasTextLayer: boolean;
  text: string;
  pages: number;
}

export function detectDocumentKind(filename: string): DocumentKind {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.tif' || ext === '.tiff') return 'tiff';
  if (ext === '.xlsx' || ext === '.xls') return 'excel';
  return 'unknown';
}

// TIFF sihirli bayt kontrolü: II*\0 (little-endian) veya MM\0* (big-endian)
export function isTiff(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  return (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
  );
}

// PDF analizi: metin katmanı (aranabilir metin) var mı?
// Taranmış PDF'lerde metin operatörleri yoktur → pdf-parse boş metin döner.
// Bazı bozuk/ilginç PDF'lerde pdf-parse hata fırlatır — bunları da
// "metin katmanı yok" kabul et (taranmış belge davranışı).
export async function analyzePdf(buffer: Buffer): Promise<PdfAnalysis> {
  try {
    const data = await pdfParse(buffer);
    const text = String(data.text || '');
    const hasTextLayer = text.replace(/\s/g, '').length > 0;
    return { hasTextLayer, text, pages: data.numpages || 1 };
  } catch {
    return { hasTextLayer: false, text: '', pages: 1 };
  }
}
