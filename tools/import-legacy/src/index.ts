/**
 * Import dei dati dal vecchio database MySQL (gestionale in uso fino al passaggio) al nuovo PostgreSQL.
 *
 * Uso (dalla cartella del backend):  npm run import:legacy
 *                                   npm run import:legacy -- --dry-run   (esegue tutto e annulla alla fine)
 *
 * Parametri di connessione nel file .env del backend: DB_* (nuovo PostgreSQL) e LEGACY_DB_* (vecchio MySQL).
 * L'import svuota le tabelle di dominio e le ricarica in un'unica transazione: o va a buon fine tutto o non cambia nulla.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import mysql from 'mysql2/promise';
import { Pool } from 'pg';
import { Importer } from './importer';

config({ path: resolve(__dirname, '../../../.env') });
config({ path: resolve(process.cwd(), '.env') });

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`Manca la variabile ${name} nel file .env`);
  return v;
}

async function main() {
  // npm intercetta "--dry-run" come propria opzione e lo passa come variabile npm_config_dry_run: si accettano entrambi
  const dryRun = process.argv.includes('--dry-run') || process.env.npm_config_dry_run === 'true';
  const log = (m: string) => console.log(m);

  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST ?? '127.0.0.1',
    port: parseInt(process.env.LEGACY_DB_PORT ?? '3306', 10),
    user: required('LEGACY_DB_USER'),
    password: process.env.LEGACY_DB_PASSWORD ?? '',
    database: required('LEGACY_DB_NAME'),
    // Date e ore come testo: vengono interpretate come ora italiana dall'import, non dal driver
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',
  });
  const pool = new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5440', 10),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: process.env.DB_PASSWORD ?? '',
  });
  const db = await pool.connect();

  log(`Import dal database MySQL "${process.env.LEGACY_DB_NAME}" al database PostgreSQL "${process.env.DB_NAME}"${dryRun ? ' (prova: nessuna modifica salvata)' : ''}`);
  const importer = new Importer(my, db, log);
  try {
    await db.query('BEGIN');
    await importer.run();
    if (dryRun) {
      await db.query('ROLLBACK');
      log('Prova terminata: transazione annullata, il database non è stato modificato.');
    } else {
      await db.query('COMMIT');
      log('Transazione confermata.');
    }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    console.error('\nImport interrotto, nessuna modifica salvata. Errore:');
    console.error(e);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
    await my.end();
  }
  console.log('\nRIEPILOGO\n');
  console.log(importer.stats.report());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
