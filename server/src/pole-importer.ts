// Direk listelerinin projeye yazılması — poles.ts (KMZ yükleme) ve
// kmz-generator.ts (Excel/PDF dönüşümü) ortak kullanır.
import { PoolClient, Pool } from 'pg';
import { pool } from './db';
import { PolePoint } from './kmz-parser';

export interface ImportResult {
  saved: number;
  routePoints: number;
  connectionKm: number | null;
  pointTotal: number;
}

export async function importPolesForProject(
  projectId: number,
  poles: PolePoint[],
  route: [number, number][] | null,
  fileName: string,
  pointTotal: number,
  connectionKm: number | null
): Promise<ImportResult> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM poles WHERE project_id = $1', [projectId]);
    for (let i = 0; i < poles.length; i++) {
      const p = poles[i];
      await client.query(
        'INSERT INTO poles (name, lat, lon, alt, idx, project_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [p.name || `Direk ${i + 1}`, p.lat, p.lon, p.alt ?? null, i, projectId]
      );
    }
    await client.query(
      `UPDATE projects SET route = $1, file_name = $2, uploaded_at = $3, point_total = $4 WHERE id = $5`,
      [JSON.stringify(route || []), fileName, new Date().toISOString(), pointTotal, projectId]
    );
    await client.query('COMMIT');
    return { saved: poles.length, routePoints: route ? route.length : 0, connectionKm, pointTotal };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
