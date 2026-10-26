// Doküman & revizyon yönetimi: pafta, DTL, onay yazıları — projeye bağlı ve revizyonlu.
// Dosyalar uploads/docs/<project_id>/ altında saklanır; indirme oturumlu.
import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pool } from '../db';
import { requireAuth, requireRole, AuthedRequest } from '../auth';

const router = Router();
router.use(requireAuth, requireRole('owner'));

const UPLOAD_DIR = path.join(__dirname, '..', '..', '..', 'uploads', 'docs');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const projectDir = path.join(UPLOAD_DIR, String((_req as AuthedRequest).body?.project_id || '0'));
    fs.mkdirSync(projectDir, { recursive: true });
    cb(null, projectDir);
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    cb(null, `${crypto.randomBytes(6).toString('hex')}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

export const DOC_CATEGORIES: Record<string, { label: string }> = {
  pafta: { label: 'Pafta / Çizim' },
  dtl: { label: 'DTL / Profil' },
  onay: { label: 'Onay Yazısı' },
  diger: { label: 'Diğer' },
};

router.get('/', async (req: Request, res: Response) => {
  const pid = Number(req.query.project_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  const { rows } = await pool.query(
    `SELECT id, category, title, revision, file_name, notes, created_at
     FROM project_documents WHERE project_id = $1 ORDER BY created_at DESC, id DESC`,
    [pid]
  );
  res.json(rows);
});

router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  const u = req as AuthedRequest;
  const pid = Number(req.body?.project_id);
  const title = String(req.body?.title || '').trim();
  const category = String(req.body?.category || 'diger');
  const revision = String(req.body?.revision || 'R0').trim().slice(0, 20);
  if (!Number.isInteger(pid) || pid <= 0) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  if (!title) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Belge başlığı zorunludur.' });
  }
  if (!DOC_CATEGORIES[category]) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Geçersiz kategori.' });
  }
  if (!req.file) return res.status(400).json({ error: 'Dosya seçilmedi (en fazla 20 MB).' });

  const { rows } = await pool.query(
    `INSERT INTO project_documents (project_id, category, title, revision, file_name, file_path, notes, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [pid, category, title.slice(0, 200), revision, req.file.originalname, req.file.path, String(req.body?.notes || '').trim().slice(0, 300), u.user?.id]
  );
  res.status(201).json(rows[0]);
});

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query('DELETE FROM project_documents WHERE id = $1 RETURNING file_path', [id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
  fs.unlink(rows[0].file_path, () => {});
  res.status(204).end();
});

// Oturumlu indirme
router.get('/:id/download', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query('SELECT file_name, file_path FROM project_documents WHERE id = $1', [id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
  if (!fs.existsSync(rows[0].file_path)) return res.status(404).json({ error: 'Dosya diskte bulunamadı.' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].file_name)}`);
  res.sendFile(path.resolve(rows[0].file_path));
});

export default router;
