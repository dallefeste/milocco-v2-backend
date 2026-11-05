/**
 * Configurazione letta dalle variabili d'ambiente (file .env nella root del progetto).
 */
export default () => ({
  port: parseInt(process.env.API_PORT ?? '3100', 10),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5180,http://localhost:5181')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5440', 10),
    name: process.env.DB_NAME ?? 'milocco',
    user: process.env.DB_USER ?? 'milocco',
    password: process.env.DB_PASSWORD ?? 'milocco',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-secret',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  },
  admin: {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? 'admin',
  },
  storageDir: process.env.STORAGE_DIR ?? './storage',
  timezone: process.env.APP_TIMEZONE ?? 'Europe/Rome',
});
