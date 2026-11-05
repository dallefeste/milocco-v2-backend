/**
 * Applica in ordine i file SQL in database/migrations che non sono ancora stati applicati.
 * Ogni file viene eseguito in una transazione e registrato nella tabella schema_migration.
 * Uso: npm run db:migrate (dalla root).
 */
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Client } from 'pg';
import { loadEnv } from '../config/load-env';

async function main(): Promise<void> {
  loadEnv();
  const dir = resolve(__dirname, '../../database/migrations');
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5440', 10),
    database: process.env.DB_NAME ?? 'milocco',
    user: process.env.DB_USER ?? 'milocco',
    password: process.env.DB_PASSWORD ?? 'milocco',
  });
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set(
    (await client.query<{ name: string }>('SELECT name FROM schema_migration')).rows.map((r) => r.name),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    process.stdout.write(`Applico ${file}... `);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migration(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('ok');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('ERRORE');
      console.error(err);
      process.exitCode = 1;
      break;
    }
  }
  console.log(count === 0 ? 'Nessuna migrazione da applicare.' : `Migrazioni applicate: ${count}`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
