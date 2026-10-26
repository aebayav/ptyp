// İSG: toolbox eğitimleri, ramak kala / kaza kayıtları, personel sertifikaları.
// Sertifika bitişine 30 gün kala ve bitmiş olanlar uyarı listesinde döner.
import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole, AuthedRequest } from '../auth';
import { toDateOrNull } from '../dates';

const router = Router();
router.use(requireAuth, requireRole('owner'));

const INCIDENT_TYPES = ['ramak_kala', 'kaza'];
const SEVERITIES = ['hafif', 'orta', 'agir'];

function pid(req: Request): number {
  return Number(req.query.project_id ?? req.body?.project_id);
}

// ---------- Özet: uyarılar + sayılar ----------
router.get('/summary', async (req: Request, res: Response) => {
  const p = pid(req);
  if (!Number.isInteger(p) || p <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  const [certs, incidents, trainings] = await Promise.all([
    pool.query('SELECT * FROM certifications WHERE project_id = $1 ORDER BY expiry_date NULLS LAST, person_name', [p]),
    pool.query('SELECT * FROM safety_incidents WHERE project_id = $1 ORDER BY incident_date DESC, id DESC LIMIT 50', [p]),
    pool.query('SELECT * FROM safety_trainings WHERE project_id = $1 ORDER BY training_date DESC, id DESC LIMIT 50', [p]),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const warnDays = (d: string) => Math.round((new Date(d).getTime() - new Date(today).getTime()) / 86400000);
  const warnings = certs.rows
    .filter((c: any) => c.expiry_date)
    .map((c: any) => ({ ...c, days_left: warnDays(c.expiry_date) }))
    .filter((c: any) => c.days_left <= 30);
  res.json({
    certifications: certs.rows,
    incidents: incidents.rows,
    trainings: trainings.rows,
    warnings: warnings.sort((a: any, b: any) => a.days_left - b.days_left),
    counts: {
      ramak_kala: incidents.rows.filter((i: any) => i.incident_type === 'ramak_kala').length,
      kaza: incidents.rows.filter((i: any) => i.incident_type === 'kaza').length,
      trainings: trainings.rows.length,
    },
  });
});

// ---------- Eğitim ----------
router.post('/trainings', async (req: Request, res: Response) => {
  const u = req as AuthedRequest;
  const p = pid(req);
  const topic = String(req.body?.topic || '').trim();
  const date = toDateOrNull(req.body?.training_date, 'eğitim tarihi') || new Date().toISOString().slice(0, 10);
  const attendees = Number(req.body?.attendees) || 0;
  if (!Number.isInteger(p) || p <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  if (!topic) return res.status(400).json({ error: 'Eğitim konusu zorunludur.' });
  const { rows } = await pool.query(
    `INSERT INTO safety_trainings (project_id, training_date, topic, attendees, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [p, date, topic.slice(0, 160), Math.max(0, attendees), String(req.body?.notes || '').trim().slice(0, 300), u.user?.id]
  );
  res.status(201).json(rows[0]);
});

router.delete('/trainings/:id', async (req: Request, res: Response) => {
  const r = await pool.query('DELETE FROM safety_trainings WHERE id = $1', [Number(req.params.id)]);
  if ((r.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
  res.status(204).end();
});

// ---------- Olay ----------
router.post('/incidents', async (req: Request, res: Response) => {
  const u = req as AuthedRequest;
  const p = pid(req);
  const itype = String(req.body?.incident_type || 'ramak_kala');
  const severity = String(req.body?.severity || 'hafif');
  const description = String(req.body?.description || '').trim();
  const date = toDateOrNull(req.body?.incident_date, 'olay tarihi') || new Date().toISOString().slice(0, 10);
  if (!Number.isInteger(p) || p <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  if (!INCIDENT_TYPES.includes(itype)) return res.status(400).json({ error: 'Geçersiz olay tipi.' });
  if (!SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Geçersiz şiddet.' });
  if (!description) return res.status(400).json({ error: 'Olay açıklaması zorunludur.' });
  const { rows } = await pool.query(
    `INSERT INTO safety_incidents (project_id, incident_date, incident_type, severity, description, root_cause, actions, reported_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      p,
      date,
      itype,
      severity,
      description.slice(0, 1000),
      String(req.body?.root_cause || '').trim().slice(0, 500),
      String(req.body?.actions || '').trim().slice(0, 500),
      u.user?.id,
    ]
  );
  res.status(201).json(rows[0]);
});

router.delete('/incidents/:id', async (req: Request, res: Response) => {
  const r = await pool.query('DELETE FROM safety_incidents WHERE id = $1', [Number(req.params.id)]);
  if ((r.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
  res.status(204).end();
});

// ---------- Sertifika ----------
router.post('/certifications', async (req: Request, res: Response) => {
  const p = Number(req.body?.project_id);
  const person_name = String(req.body?.person_name || '').trim();
  const cert_type = String(req.body?.cert_type || '').trim();
  if (!Number.isInteger(p) || p <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  if (!person_name) return res.status(400).json({ error: 'Personel adı zorunludur.' });
  if (!cert_type) return res.status(400).json({ error: 'Sertifika türü zorunludur.' });
  const { rows } = await pool.query(
    `INSERT INTO certifications (project_id, person_name, cert_type, issue_date, expiry_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      p,
      person_name.slice(0, 120),
      cert_type.slice(0, 120),
      toDateOrNull(req.body?.issue_date, 'veriliş tarihi'),
      toDateOrNull(req.body?.expiry_date, 'bitiş tarihi'),
      String(req.body?.notes || '').trim().slice(0, 300),
    ]
  );
  res.status(201).json(rows[0]);
});

router.delete('/certifications/:id', async (req: Request, res: Response) => {
  const r = await pool.query('DELETE FROM certifications WHERE id = $1', [Number(req.params.id)]);
  if ((r.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
  res.status(204).end();
});

export default router;
