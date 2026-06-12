import pg from 'pg';
import environment from '../config/environment.js';

const { Pool } = pg;

// Initialize high-performance connection pool straight to your Postgres instance
export const dbPool = new Pool({
  connectionString: environment.DATABASE_URL,
});

export async function query(text: string, params?: any[]) {
  const start = Date.now();
  const res = await dbPool.query(text, params);
  const duration = Date.now() - start;
  
  // Clean execution monitoring
  console.log(`[DB] Executed query in ${duration}ms | Rows: ${res.rowCount}`);
  return res;
}