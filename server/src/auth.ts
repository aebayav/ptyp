import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { pool } from './db';

export interface AuthedUser {
  id: number;
  username: string;
  role: 'owner' | 'supplier';
  supplier_id: number | null;
}

export interface AuthedRequest extends Request {
  user?: AuthedUser;
}

// Kimlik doğrulama: Bearer token doğrulanır, kullanıcı DB'den tazelenir
// (silinmiş/rolü değişmiş kullanıcılar anında etkilenir)
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Oturum bulunamadı. Lütfen giriş yapın.' });
    return;
  }
  let payload: { uid: number };
  try {
    payload = jwt.verify(token, config.jwtSecret) as { uid: number };
  } catch {
    res.status(401).json({ error: 'Oturum süresi doldu veya geçersiz. Lütfen tekrar giriş yapın.' });
    return;
  }
  const r = await pool.query('SELECT id, username, role, supplier_id FROM users WHERE id = $1', [payload.uid]);
  if (r.rowCount === 0) {
    res.status(401).json({ error: 'Kullanıcı hesabı bulunamadı.' });
    return;
  }
  req.user = r.rows[0];
  next();
}

export function requireRole(role: 'owner' | 'supplier') {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user || req.user.role !== role) {
      res.status(403).json({ error: 'Bu işlem için yetkiniz yok.' });
      return;
    }
    next();
  };
}
