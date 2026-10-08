import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { pool } from '../db';
import { AuthedRequest, requireAuth } from '../auth';

const router = Router();

function publicUser(u: any) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    display_name: u.display_name,
    supplier_id: u.supplier_id,
  };
}

// Giriş
router.post('/login', async (req: Request, res: Response) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanıcı adı ve şifre zorunludur.' });
  }
  const r = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  if (r.rowCount === 0 || !bcrypt.compareSync(password, r.rows[0].password_hash)) {
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
  }
  const token = jwt.sign({ uid: r.rows[0].id }, config.jwtSecret, {
    expiresIn: config.jwtExpires as jwt.SignOptions['expiresIn'],
  });
  res.json({ token, user: publicUser(r.rows[0]) });
});

// Oturumdaki kullanıcı bilgisi
router.get('/me', requireAuth, async (req: AuthedRequest, res: Response) => {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [req.user!.id]);
  res.json(publicUser(r.rows[0]));
});

// Şifre değiştir
router.post('/change-password', requireAuth, async (req: AuthedRequest, res: Response) => {
  const oldPassword = String(req.body?.old_password || '');
  const newPassword = String(req.body?.new_password || '');
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Yeni şifre en az 6 karakter olmalıdır.' });
  }
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [req.user!.id]);
  if (!bcrypt.compareSync(oldPassword, r.rows[0].password_hash)) {
    return res.status(400).json({ error: 'Mevcut şifre hatalı.' });
  }
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
    bcrypt.hashSync(newPassword, 10),
    req.user!.id,
  ]);
  res.json({ ok: true });
});

export default router;
