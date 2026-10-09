import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import pdf from 'pdf-parse';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import { pool } from '../db';
import { detectQuotes, unmatchedLines } from '../quote-parser';

const router = Router();

// Dosya diske yazılmaz — bellekte parse edilir (en fazla 10 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const ALLOWED = new Set(['.pdf', '.xlsx', '.xls', '.docx', '.csv', '.txt']);

async function fileToText(buffer: Buffer, ext: string): Promise<string> {
  if (ext === '.pdf') {
    const r = await pdf(buffer);
    return r.text || '';
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const lines: string[] = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false }) as unknown[][];
      for (const row of rows) {
        lines.push(row.map((c) => String(c ?? '')).join(' | ').trim());
      }
    }
    return lines.filter(Boolean).join('\n');
  }
  if (ext === '.docx') {
    const r = await mammoth.extractRawText({ buffer });
    return r.value || '';
  }
  // .csv / .txt
  return buffer.toString('utf8');
}

// Halka açık uç: satıcılar giriş yapmadan teklif dosyası yükler
router.post('/quote-upload', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const firmName = String(req.body?.firm_name || '').trim();
    const contact = String(req.body?.contact || '').trim();
    const email = String(req.body?.email || '').trim();
    if (!firmName) return res.status(400).json({ error: 'Firma adı zorunludur.' });
    if (!req.file) return res.status(400).json({ error: 'Teklif dosyası yüklenmedi.' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED.has(ext)) {
      return res.status(400).json({
        error: 'Desteklenmeyen dosya türü. PDF, Excel (xlsx/xls), Word (docx), CSV veya TXT yükleyin.',
      });
    }

    let text: string;
    try {
      text = await fileToText(req.file.buffer, ext);
    } catch {
      return res.status(400).json({ error: 'Dosya okunamadı. Dosyanın bozuk veya şifreli olmadığından emin olun.' });
    }
    if (!text || text.trim().length < 10) {
      return res.status(400).json({ error: 'Dosyadan metin çıkarılamadı. Taranmış (görsel) PDF ise OCR desteklenmiyor.' });
    }

    const materials = (await pool.query('SELECT id, name FROM materials')).rows;
    if (materials.length === 0) {
      return res.status(400).json({ error: 'Sistemde henüz eşleştirilecek malzeme tanımlı değil.' });
    }

    const detected = detectQuotes(text, materials);

    // Firma: ada göre bul veya otomatik kaydet
    let supplier = (
      await pool.query('SELECT id, name FROM suppliers WHERE lower(name) = $1', [
        firmName.toLocaleLowerCase('tr-TR'),
      ])
    ).rows[0];
    let createdSupplier = false;
    if (!supplier) {
      const ins = await pool.query(
        'INSERT INTO suppliers (name, contact_name, email) VALUES ($1, $2, $3) RETURNING id, name',
        [firmName, contact, email]
      );
      supplier = ins.rows[0];
      createdSupplier = true;
    }

    // Tespit edilen fiyatları teklif olarak yaz
    const saved: unknown[] = [];
    for (const d of detected) {
      const ins = await pool.query(
        `INSERT INTO quotes (material_id, supplier_id, price, currency, status, notes)
         VALUES ($1, $2, $3, $4, 'received', $5) RETURNING id`,
        [d.material_id, supplier.id, d.price, d.currency, `Otomatik tespit (${req.file!.originalname}): "${d.line}"`]
      );
      saved.push({
        id: ins.rows[0].id,
        material_id: d.material_id,
        material_name: d.material_name,
        price: d.price,
        currency: d.currency,
      });
    }

    const unmatched =
      detected.length === 0
        ? unmatchedLines(text, [])
        : unmatchedLines(text, detected.map((d) => d.material_name));

    res.json({
      firm_name: firmName,
      supplier_id: supplier.id,
      created_supplier: createdSupplier,
      file: req.file.originalname,
      saved_count: saved.length,
      saved,
      unmatched,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
