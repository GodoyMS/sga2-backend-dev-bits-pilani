/**
 * Runs the whole system against an in-memory Postgres (pg-mem), so the API,
 * Swagger UI and map console can be tried without installing a database.
 * Usage: npm run dev:memory
 */
import { newDb } from 'pg-mem';
import { setPool } from '../src/shared/db';
import { main } from '../src/index';

const db = newDb();
const { Pool } = db.adapters.createPg();
setPool(new Pool());

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
