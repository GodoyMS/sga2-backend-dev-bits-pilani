import { Pool, type QueryResultRow } from 'pg';
import { config } from '../config';

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  end?: () => Promise<void>;
}

let pool: Queryable | null = null;

/** Lets tests swap in an in-memory database (pg-mem). */
export function setPool(p: Queryable): void {
  pool = p;
}

export function getPool(): Queryable {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
    }) as unknown as Queryable;
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function closePool(): Promise<void> {
  if (pool?.end) await pool.end();
  pool = null;
}
