import { config } from 'dotenv';
import { resolve } from 'path';

/** Carica il file .env nella cartella del backend (vale sia da src/ con ts-node sia da dist/). */
export function loadEnv(): void {
  config({ path: resolve(__dirname, '../../.env') });
  config({ path: resolve(process.cwd(), '.env') });
}
