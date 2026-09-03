import pg from 'pg';
import 'dotenv/config';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Convenience helper for a single query. For multi-statement transactions
// (anything touching Assignment + Unit + Outbox together), grab a client
// directly with pool.connect() and use BEGIN/COMMIT — see services/dispatch.js.
export async function query(text, params) {
  return pool.query(text, params);
}
