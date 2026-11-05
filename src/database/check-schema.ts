/**
 * Verifica che ogni entità TypeORM corrisponda a una tabella esistente e che tutte le colonne mappate esistano.
 * Uso: npm run check:schema
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { loadEnv } from '../config/load-env';
import { ALL_ENTITIES } from '../entities/all';

async function main() {
  loadEnv();
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5440', 10),
    database: process.env.DB_NAME ?? 'milocco',
    username: process.env.DB_USER ?? 'milocco',
    password: process.env.DB_PASSWORD ?? 'milocco',
    entities: ALL_ENTITIES as never[],
    namingStrategy: new SnakeNamingStrategy(),
  });
  await ds.initialize();
  let errors = 0;
  for (const meta of ds.entityMetadatas) {
    const cols = await ds.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [meta.tableName],
    );
    const existing = new Set(cols.map((c: { column_name: string }) => c.column_name));
    if (existing.size === 0) { console.log(`✗ tabella mancante: ${meta.tableName}`); errors++; continue; }
    for (const c of meta.columns) {
      if (!existing.has(c.databaseName)) { console.log(`✗ ${meta.tableName}.${c.databaseName} non esiste`); errors++; }
    }
  }
  console.log(errors === 0 ? `Schema allineato (${ds.entityMetadatas.length} entità).` : `${errors} problemi.`);
  await ds.destroy();
  process.exit(errors ? 1 : 0);
}
main();
