// Kamulaştırma / arazi takibi — açıklık (direk arası) bazında parsel kayıtları.
// ENH'de işi en çok geciktiren konu: izinsiz parseller haritada kırmızı görünür.
import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';

const router = Router();

// Kamulaştırma ofis işi — yalnız iş sahibi
router.use(requireAuth, requireRole('owner'));

export const EASEMENT_STATUSES: Record<string, { label: string; color: string }> = {
  belirsiz: { label: 'Belirsiz', color: '#94a3b8' },
  basvuruda: { label: 'Başvuruda', color: '#d97706' },
  izinli: { label: 'İzinli', color: '#16a34a' },
  izinsiz: { label: 'İzinsiz', color: '#dc2626' },
};

export const LEGAL_STATUSES: Record<string, { label: string }> = {
  yok: { label: '—' },
  anlasma: { label: 'Anlaşma' },
  dava: { label: 'Dava' },
  kamulastirma: { label: 'Kamulaştırma' },
};

// Parse listesi: direk adlarıyla birlikte (harita renklendirmesi için açıklıklar)
router.get('/', async (req: Request, res: Response) => {
  const pid = Number(req.query.project_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  const { rows } = await pool.query(
    `SELECT p.*,
            pf.name AS pole_from_name,
            pt.name AS pole_to_name
     FROM parcels p
     LEFT JOIN poles pf ON pf.project_id = p.project_id AND pf.idx = p.pole_from_idx
     LEFT JOIN poles pt ON pt.project_id = p.project_id AND pt.idx = p.pole_to_idx
     WHERE p.project_id = $1
     ORDER BY p.pole_from_idx, p.pole_to_idx`,
    [pid]
  );
  res.json(rows);
});

// Bir projenin direkleri (açıklık seçimi için)
router.get('/poles', async (req: Request, res: Response) => {
  const pid = Number(req.query.project_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  const { rows } = await pool.query(
    `SELECT idx, name, lat, lon, meta->>'tower_type' AS tower_type
     FROM poles WHERE project_id = $1 ORDER BY idx`,
    [pid]
  );
  res.json(rows);
});

const EASEMENT_VALUES = Object.keys(EASEMENT_STATUSES);
const LEGAL_VALUES = Object.keys(LEGAL_STATUSES);

function normalize(body: any) {
  const price = body.price === '' || body.price == null ? null : Number(body.price);
  return {
    project_id: Number(body.project_id),
    pole_from_idx: Number(body.pole_from_idx),
    pole_to_idx: Number(body.pole_to_idx),
    parcel_no: String(body.parcel_no || '').trim().slice(0, 80),
    owner_name: String(body.owner_name || '').trim().slice(0, 160),
    easement_status: EASEMENT_VALUES.includes(String(body.easement_status)) ? String(body.easement_status) : 'belirsiz',
    legal_status: LEGAL_VALUES.includes(String(body.legal_status)) ? String(body.legal_status) : 'yok',
    price: price != null && Number.isFinite(price) && price >= 0 ? price : null,
    notes: String(body.notes || '').trim().slice(0, 500),
  };
}

async function validate(g: any): Promise<string | null> {
  if (!Number.isInteger(g.project_id) || g.project_id <= 0) return 'Geçerli bir proje seçin.';
  if (!Number.isInteger(g.pole_from_idx) || g.pole_from_idx < 0 || !Number.isInteger(g.pole_to_idx) || g.pole_to_idx < 0) {
    return 'Geçerli direk seçin.';
  }
  if (g.pole_from_idx >= g.pole_to_idx) return 'Bitiş direği başlangıçtan sonra olmalı.';
  const poles = await pool.query(
    'SELECT COUNT(*)::int AS c FROM poles WHERE project_id = $1 AND idx IN ($2, $3)',
    [g.project_id, g.pole_from_idx, g.pole_to_idx]
  );
  if (poles.rows[0].c < 2) return 'Seçilen direkler projede bulunamadı.';
  return null;
}

router.post('/', async (req: Request, res: Response) => {
  const g = normalize(req.body || {});
  const err = await validate(g);
  if (err) return res.status(400).json({ error: err });
  const { rows } = await pool.query(
    `INSERT INTO parcels (project_id, pole_from_idx, pole_to_idx, parcel_no, owner_name, easement_status, legal_status, price, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [g.project_id, g.pole_from_idx, g.pole_to_idx, g.parcel_no, g.owner_name, g.easement_status, g.legal_status, g.price, g.notes]
  );
  res.status(201).json(rows[0]);
});

router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz kayıt.' });
  const g = normalize(req.body || {});
  const err = await validate(g);
  if (err) return res.status(400).json({ error: err });
  const r = await pool.query('SELECT 1 FROM parcels WHERE id = $1', [id]);
  if ((r.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
  const { rows } = await pool.query(
    `UPDATE parcels SET project_id=$1, pole_from_idx=$2, pole_to_idx=$3, parcel_no=$4, owner_name=$5,
       easement_status=$6, legal_status=$7, price=$8, notes=$9, updated_at=now()
     WHERE id=$10 RETURNING *`,
    [g.project_id, g.pole_from_idx, g.pole_to_idx, g.parcel_no, g.owner_name, g.easement_status, g.legal_status, g.price, g.notes, id]
  );
  res.json(rows[0]);
});

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz kayıt.' });
  const r = await pool.query('DELETE FROM parcels WHERE id = $1', [id]);
  if ((r.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
  res.status(204).end();
});

export default router;
