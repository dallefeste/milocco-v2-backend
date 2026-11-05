# Milocco v2 — backend

API del gestionale di produzione: NestJS 11 + TypeORM + PostgreSQL 17. Prefisso `/api`, documentazione su
`/api/docs`. Contiene anche le migrazioni del database e l'import dal vecchio gestionale.
Panoramica, avvio di tutto e messa in produzione: README del repository `milocco-v2-environment`.

## Sviluppo
```bash
cp .env.example .env     # compilare almeno JWT_SECRET e ADMIN_PASSWORD
npm install              # installa anche le dipendenze dell'import (tools/import-legacy)
npm run migrate          # applica le migrazioni mancanti (database/migrations/*.sql)
npm run start:dev        # http://localhost:3100/api
```
Il database si avvia dal repository environment (`docker compose up -d db`).

## Import dei dati dal vecchio gestionale
Il vecchio database MySQL va ripristinato su un MySQL raggiungibile; i parametri sono `LEGACY_DB_*` nel `.env`.
```bash
npm run import:legacy -- --dry-run   # prova completa senza salvare nulla
npm run import:legacy                # import vero (svuota e ricarica i dati, ~10 secondi)
```
Si può rilanciare quante volte serve. Gli utenti arrivano **senza password**: l'amministratore la imposta da
Amministrazione → Utenti (anche per l'utente del tablet). Mappature e correzioni: `docs/import-dati.md`.

## Controlli
```bash
npm test                 # test automatici (jest)
npm run check:schema     # entità TypeORM allineate al database
npm run build            # compilazione
```

## Struttura
- `src/modules/<area>/` — moduli per area (masterdata, technical, sales, production, shopfloor, reports, …).
- `src/entities/` — entità TypeORM. `src/shared/` — tipi condivisi con client e tablet (copia identica).
- `database/migrations/` — schema del database: solo file nuovi, mai modificare quelli già applicati.
- `tools/import-legacy/` — import dal vecchio MySQL.
- `Dockerfile` — immagine dell'API: all'avvio applica le migrazioni e parte.
