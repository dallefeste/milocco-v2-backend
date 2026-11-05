# Milocco v2 — backend

NestJS 11 + TypeORM + PostgreSQL. Scrivere in italiano (messaggi, commenti).

- Prima di lavorare: `../environment/docs/architettura.md` (convenzioni, contratti tra le aree, ruoli);
  specifica in `../environment/docs/analisi/`, decisioni in `../environment/docs/decisioni.md`.
- Node 22 (`nvm use`); database con `docker compose up -d db` in `../environment` (porta 5440).
- Comandi: `npm run migrate`, `npm run check:schema`, `npm run start:dev`, `npm test`, `npm run build`.
- Schema DB: solo tramite nuovi file in `database/migrations/` (mai modificare quelli già applicati).
- `src/shared/` è identico in `../client` e `../tablet`: se lo cambi, copialo e lancia
  `../environment/scripts/check-shared.sh`.
- Credenziali e parametri solo nel file `.env` (mai nel codice).
