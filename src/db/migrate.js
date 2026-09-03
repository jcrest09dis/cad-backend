import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, 'migrations');

/**
 * Tracks which migration files have already run in a schema_migrations
 * table, so re-running this script only applies new files instead of
 * re-running everything from scratch every time (which only worked
 * before by luck, on a database that happened to be empty).
 */
async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query(`SELECT filename FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.filename));

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping ${file} (already applied).`);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`Applying ${file}...`);
    await pool.query(sql);
    await pool.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
  }
  console.log('Migrations complete.');
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
