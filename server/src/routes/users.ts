import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db';
import { AuthedRequest, requireAuth, requireRole } from '../auth';

const router = Router();

// Kullanıcı yönetimi yalnızca iş sahibi (owner) rolüne açık
router.use(requireAuth, requireRole('owner'));

// Kullanıcı listesi
router.get('/', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.username, u.role, u.display_name, u.supplier_id, u.created_at,
           s.name AS supplier_name
    FROM users u
    LEFT JOIN suppliers s ON s.id = u.supplier_id
    ORDER BY u.username
  `);
  res.json(rows);
});

function normalize(body: any) {
  return {
    username: String(body.username || '').trim(),
    password: String(body.password || ''),
    role: String(body.role || 'supplier'),
    display_name: String(body.display_name || '').trim(),
    supplier_id: body.supplier_id === '' || body.supplier_id == null ? null : Number(body.supplier_id),
  };
}

async function validate(u: any, excludeId?: number): Promise<string | null> {
  if (!u.username) return 'Kullanıcı adı zorunludur.';
  if (!['owner', 'supplier'].includes(u.role)) return 'Geçersiz rol.';
  const dup = await pool.query('SELECT 1 FROM users WHERE username = $1 AND id != $2', [u.username, excludeId || -1]);
  if (dup.rowCount) return `"${u.username}" kullanıcı adı zaten alınmış.`;
  if (u.role === 'supplier') {
    if (!u.supplier_id) return 'Satıcı rolü için bir satıcı firması seçilmelidir.';
    const s = await pool.query('SELECT 1 FROM suppliers WHERE id = $1', [u.supplier_id]);
    if (s.rowCount === 0) return 'Seçilen satıcı firması bulunamadı.';
  }
  return null;
}

// Yeni kullanıcı
router.post('/', async (req: Request, res: Response) => {
  const u = normalize(req.body || {});
  const err = await validate(u);
  if (err) return res.status(400).json({ error: err });
  if (u.password.length < 6) return res.status(400).json({ error: 'Şifre en az 6 karakter olmalıdır.' });

  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash, role, display_name, supplier_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, username, role, display_name, supplier_id, created_at`,
    [u.username, bcrypt.hashSync(u.password, 10), u.role, u.display_name, u.role === 'supplier' ? u.supplier_id : null]
  );
  res.status(201).json(rows[0]);
});

// Kullanıcı güncelle (şifre boşsa değişmez)
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

  const u = normalize(req.body || {});
  const err = await validate(u, id);
  if (err) return res.status(400).json({ error: err });
  if (u.password && u.password.length < 6) return res.status(400).json({ error: 'Şifre en az 6 karakter olmalıdır.' });

  const supplierId = u.role === 'supplier' ? u.supplier_id : null;
  if (u.password) {
    await pool.query(
      `UPDATE users SET username=$1, password_hash=$2, role=$3, display_name=$4, supplier_id=$5 WHERE id=$6`,
      [u.username, bcrypt.hashSync(u.password, 10), u.role, u.display_name, supplierId, id]
    );
  } else {
    await pool.query(
      `UPDATE users SET username=$1, role=$2, display_name=$3, supplier_id=$4 WHERE id=$5`,
      [u.username, u.role, u.display_name, supplierId, id]
    );
  }
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, u.display_name, u.supplier_id, u.created_at, s.name AS supplier_name
     FROM users u LEFT JOIN suppliers s ON s.id = u.supplier_id WHERE u.id = $1`,
    [id]
  );
  res.json(rows[0]);
});

// Kullanıcı sil (kendini ve son yöneticiyi silme engeli)
router.delete('/:id', async (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (id === req.user!.id) return res.status(400).json({ error: 'Kendi hesabınızı silemezsiniz.' });
  const existing = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  if (existing.rows[0].role === 'owner') {
    const owners = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE role = 'owner'`);
    if (owners.rows[0].c <= 1) return res.status(400).json({ error: 'Son yönetici hesabı silinemez.' });
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  res.status(204).end();
});

// Şifre sıfırla (yönetici tarafından)
router.post('/:id/reset-password', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const newPassword = String(req.body?.password || '');
  if (newPassword.length < 6) return res.status(400).json({ error: 'Yeni şifre en az 6 karakter olmalıdır.' });
  const r = await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(newPassword, 10), id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  res.json({ ok: true });
});

export default router;
