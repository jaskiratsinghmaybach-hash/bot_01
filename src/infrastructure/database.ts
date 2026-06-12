import pg from 'pg';
import environment from '../config/environment.js';

const { Pool } = pg;

// Initialize high-performance connection pool straight to your Postgres instance
export const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD, // This forces it to use 'postgres'
  port: Number(process.env.DB_PORT) || 5432,
});
export async function query(text: string, params?: any[]) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  
  // Clean execution monitoring
  console.log(`[DB] Executed query in ${duration}ms | Rows: ${res.rowCount}`);
  return res;
}