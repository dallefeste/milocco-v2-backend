# Import dei dati dal vecchio gestionale

Lo strumento in `tools/import-legacy/` copia i dati dal database MySQL del vecchio gestionale
(`milocco_backoffice`) nel database PostgreSQL del nuovo sistema. Si lancia una volta prima del passaggio
e si può rilanciare quante volte serve: ogni esecuzione riparte da zero e produce lo stesso risultato.

## Come si lancia

1. Nel file `.env` del backend devono esserci i parametri dei due database:
   - `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`: il nuovo PostgreSQL (quello in cui si scrive);
   - `LEGACY_DB_HOST`, `LEGACY_DB_PORT`, `LEGACY_DB_NAME`, `LEGACY_DB_USER`, `LEGACY_DB_PASSWORD`: il vecchio MySQL
     (solo lettura, non viene mai modificato).
2. Lo schema del nuovo database deve essere aggiornato: `npm run migrate`.
3. Dalla cartella del backend:

```bash
npm run import:legacy             # import vero
npm run import:legacy -- --dry-run   # prova: fa tutto, stampa il riepilogo e annulla (il database non cambia)
```

Dura una decina di secondi sui dati attuali. Alla fine stampa un riepilogo: per ogni tabella righe lette,
importate, scartate (con il motivo) e corrette (con il motivo).

## Cosa fa

- Apre **un'unica transazione**: se qualcosa va storto non resta nulla a metà e il database resta com'era.
- **Svuota** (`TRUNCATE … RESTART IDENTITY CASCADE`) tutte le tabelle di dominio dello schema `0002_domain.sql`
  (anagrafiche, disegni, ordini, pianificazione, registrazioni di reparto, segnalazioni, registro modifiche,
  allegati, chiusure straordinarie del calendario). **Non** svuota `app_user`, `app_setting`, `schema_migration`.
  Attenzione: ogni dato inserito a mano nel nuovo sistema in queste tabelle viene cancellato.
- Reimporta tutto e alla fine riallinea i contatori degli id (il prossimo id = massimo importato + 1).
- **Conserva gli id originali** dove c'è un corrispettivo diretto, in particolare l'**id dell'ordine di produzione,
  che è il numero d'ordine** visibile a officina e clienti. Id conservati per: clienti, fornitori, reparti, operatori,
  tipologie macchina, macchine, materiali, finiture, trattamenti, causali di fermo, lavori extra, tipologie barra,
  disegni, particolari, composizione disegni, ciclo dei particolari, ordini cliente e righe, preventivi e righe,
  ordini di produzione e loro particolari, lavorazioni pianificate, coda di taglio, fasi, fermi, lavori extra
  registrati, collaudi, segnalazioni.

## Corrispondenza delle tabelle

| Vecchia tabella | Nuova tabella | Note |
|---|---|---|
| `reparto` | `department` | `is_production` per il reparto indicato dall'impostazione `id_reparto_produzione` |
| `cliente` | `customer` | il codice anagrafica del vecchio gestionale contabile (`IdAnagrafica`) non si importa |
| `fornitore`, `operatore`, `materiale`, `finitura`, `lavoro_extra` | `supplier`, `operator`, `material`, `finish`, `extra_activity` | |
| `tipologia_macchina` | `machine_type` | vedi "ruoli delle tipologie" sotto |
| `macchina`, `macchina_cliente` | `machine`, `customer_machine_rate` | `pianifica` → `schedulable` |
| `trattamento` | `treatment` | `unitaMisura` `0_DM2`/`1_KG`/vuoto → `DM2`/`KG`/vuoto |
| `fermo_macchina` | `stop_reason` | `tipo` pausa/interruzione (qualsiasi maiuscola) → `PAUSE`/`INTERRUPTION`; "fine giornata lavorativa" → `ends_workday` |
| `orario_giornaliero` | `work_calendar_day` | 00:00–00:00 = giorno chiuso (ore vuote) |
| `tipologia_barra` | `bar_type` | codice ricostruito: `MP` + codice materiale + forma + codice finitura + dimensioni |
| — | `bar_stock` | una riga a **0 metri** per tipologia: il vecchio database non conteneva le giacenze; si caricano con i movimenti del Magazzino barre |
| `disegno`, `disegno_particolare`, `disegno_trattamento` | `drawing`, `drawing_part`, `drawing_treatment` | `numero_particolare` → `position` |
| `particolare` | `part` | forma e misure ricavate dal testo dimensioni (sotto) |
| `particolare_tipologia_macchina` | `part_cycle_step` | `sequence` = ordine di inserimento (id) nel particolare; durate in secondi |
| `offerta`, `offerta_disegno` | `customer_order`, `customer_order_line` | stato riga `0_DA_CONFERMARE`/`1_CONFERMATA` → `PENDING`/`CONFIRMED`; il documento del vecchio gestionale contabile (`IdDoc`) non si importa |
| `preventivo`, `particolare_preventivo`, `fase_lavorazione_particolare_preventivo`, `trattamento_particolare_preventivo` | `quote`, `quote_part`, `quote_part_phase`, `quote_part_treatment` | nella riga preventivo si copiano peso e superfici del particolare |
| `ordine`, `ordine_trattamento`, `ordine_particolare` | `production_order`, `production_order_treatment`, `production_order_part` | vedi sotto |
| `lavorazione` (+ `lavorazione_fase`) | `schedule_item` | vedi sotto |
| `scheduler_taglio` | `cut_queue_item` | `0_IN_ATTESA`/`1_IN_LAVORAZIONE`/`2_COMPLETATO` → `WAITING`/`IN_PROGRESS`/`COMPLETED` |
| `fase` | `work_phase` | stato `0`/`1`/`2` → `IN_PROGRESS`/`COMPLETED`/`SUSPENDED`; quelle rimaste aperte vengono chiuse (vedi sotto) |
| `fermo_macchina_storico` | `work_stop` | `macchinaFerma` → `machine_stopped` |
| `lavoro_extra_storico` | `extra_activity_log` | |
| `collaudo` | `inspection` | macchina = la postazione di tipo collaudo (COLLAUDO), se ce n'è una sola |
| `utente` (+ livelli) | `app_user` | vedi "utenti" |
| `rail` | `support_ticket` | priorità `1_BASSA`…`4_BLOCCANTE` → `LOW`…`BLOCKING`; stati `APERTO` → `OPEN`, `NON_RISCONTRATO` → `NOT_REPRODUCIBLE`, ecc. |
| `impostazione_sistema` `prezzo_minuto_progettazione_cam` | `app_setting` `cam_price_per_minute` | |

### Conversioni generali
- **Date e ore**: il vecchio DB le salvava in ora locale senza fuso; vengono lette come ora italiana
  (Europe/Rome, con ora legale) e salvate come istanti assoluti (`timestamptz`).
- **Durate** (`TIME`, anche oltre 24 ore): convertite in **secondi**. Durate vuote o negative → 0 (contate).
- **Righe cancellate** (`deleted = 1`): importate con `deleted_at` = momento dell'import (il vecchio DB non
  registrava quando una riga era stata cancellata).
- Numeri decimali salvati come `float` nel vecchio DB: arrotondati a 4 decimali (2 per i prezzi orari).

### Ruoli delle tipologie macchina
Nel vecchio sistema alcuni id erano usati in modo fisso; ora sono attributi espliciti ricavati dal nome:
"taglio" → `is_cutting`, "collaudo" → `is_inspection`, tornitura/fresatura/elettroerosione →
`plan_on_order_confirm`. `excel_column` = nome in maiuscolo senza accenti (TAGLIO, FRESATURA, TORNITURA,
ELETTROEROSIONE, STOZZATURA, RETTIFICA, FORATURA, COLLAUDO).

### Particolari: forma e misure
Il testo `dimensioni` scritto dal calcolatore peso (`<Forma> - <param><valore> … L<lunghezza>`, es.
`Barra circolare - d50 L43`) viene interpretato con le forme del calcolatore del backend
(`backend/src/modules/technical/weight-calculator.ts`): `shape` = chiave della forma (es. `ROUND_BAR`),
`shape_params` = misure in mm, `cut_length_mm` = parametro L. Per l'Angolare i lati sono scritti
`L1<valore> L2<valore>` (es. `Angolare - L115 L210 t1.5 L74` = lati 15 e 10, spessore 1,5, lunghezza 74): la
lunghezza è l'ultimo "L". I testi liberi ("A Disegno", "VARIE", "D.80 x 45"…) restano solo come testo, con
forma e misure vuote. Sui dati attuali circa 3 770 particolari hanno forma e lunghezza.

### Ordini di produzione
- `id` = numero d'ordine originale; stato `0`/`1`/`2` → `TO_DO`/`IN_PROGRESS`/`COMPLETED`.
- `customer_order_line_id` = la riga dell'ordine cliente con lo stesso disegno, solo se ce n'è **una sola**;
  altrimenti vuoto (contato nel riepilogo).
- `started_at` = inizio della prima fase o del primo collaudo; `completed_at` (solo ordini completati) = fine
  dell'ultimo collaudo, altrimenti fine dell'ultima fase, altrimenti vuoto (ordini vecchi senza registrazioni).
- `production_order_part`: `quantity_per_unit` = quantità del particolare nel disegno dell'ordine (1 se il
  particolare non è più nel disegno); `cut_status`: `ignoratoTaglio` → `IGNORED` (prevale), `importatoTaglio` →
  `APPROVED`, altrimenti `NONE`.

### Lavorazioni pianificate (`schedule_item`)
- `quantity` = quantità ordine × quantità del particolare nel disegno (solo quantità ordine se il particolare non
  è nel disegno); `position` = campo `ordine` (posizione in coda).
- `status`: `DONE` se ha una fase collegata completata nel vecchio sistema o se l'ordine è completato; altrimenti
  `OPEN`. Il vecchio sistema la metteva "in corso" se aveva fasi collegate in corso o sospese: quelle fasi vengono
  chiuse dall'import (sotto), quindi la lavorazione resta **da fare** e non diventa conclusa per la chiusura
  automatica (10 lavorazioni sui dati attuali). `completed_at` = fine dell'ultima fase collegata completata (vuota
  se è conclusa solo perché l'ordine è completato).
- Fasi: `schedule_item_id` dal collegamento `lavorazione_fase` (se una fase è collegata a più lavorazioni si prende
  la prima); `resumed_from_id`: tra le fasi con stesso ordine, particolare e numero fase, ognuna riprende la
  precedente se quella era sospesa.

### Attività rimaste aperte nel vecchio sistema
Fasi, fermi, lavori extra e collaudi senza fine sono registrazioni dimenticate aperte anni fa (2018-2019): l'import
le chiude, così non compaiono come attività in corso nel cruscotto e nel tablet. Non si inventano ore.
- **Fasi** in corso, oppure sospese e **mai riprese** → concluse (`COMPLETED`). Fine attrezzaggio mancante = ultimo
  orario già registrato sulla fase (inizio lavorazione o inizio attrezzaggio); fine lavorazione mancante = inizio
  lavorazione. Le fasi sospese e poi riprese restano sospese: è lo stato normale di una fase ripresa.
- **Fermi, lavori extra, collaudi** senza fine → fine = inizio (durata zero).
- Nota "Chiusa automaticamente all'import: era rimasta aperta nel vecchio sistema": nelle note del collaudo; per
  fasi, fermi e lavori extra (che non hanno note) è una voce del registro modifiche (utente "import") con i campi
  riempiti.
- Lo stato degli ordini di produzione non cambia; le lavorazioni pianificate collegate restano da fare (sopra).
- Sui dati attuali: 1 091 fasi in corso, 153 fasi sospese mai riprese, 165 fermi, 37 lavori extra, 199 collaudi
  (righe "corrette" del riepilogo; 1 645 voci nel registro modifiche).

### Utenti
- Importati **senza password**: non possono accedere finché un amministratore non imposta una password
  (Amministrazione → Utenti); al primo accesso devono cambiarla (`must_change_password`).
- Ruolo: `ADMIN` per il livello 0 (Administrator), `OFFICE` per il livello 1 (inserimento ordini), `TABLET` per
  l'utente "tablet". `enabled` come nel vecchio sistema.
- Ricevono **id nuovi** (non quelli vecchi). Non vengono importati gli username elencati in `LEGACY_SKIP_USERS`
  (separati da virgola) né, se `LEGACY_COMPANY_EMAIL_DOMAIN` è impostato, gli account con email di un altro dominio
  (account di fornitori esterni); l'utente tablet viene importato senza email. Gli utenti già presenti nel nuovo
  sistema (stesso username, es. "admin") **non vengono toccati**. A un nuovo lancio, gli utenti importati in
  precedenza e non ancora attivati con una password vengono riallineati; quelli già attivati restano come sono.

## Dati sporchi: cosa si scarta o si corregge, e perché

Nessun dato sporco blocca l'import: ogni scarto o correzione è contato nel riepilogo finale. Sui dati attuali:

| Caso | Cosa fa l'import | Perché |
|---|---|---|
| Clienti, disegni e ordini cliente **cancellati fisicamente** dal vecchio DB ma ancora citati (9 clienti, 109 disegni, 5 ordini cliente) | Ricrea una riga segnaposto con lo **stesso id**, eliminata logicamente, nome "… eliminato nel vecchio sistema" | Senza, si perderebbero ~160 ordini di produzione (con i loro numeri e collaudi) e centinaia di righe; il nuovo schema richiede disegno e cliente |
| Ordini cliente con cliente 0 o vuoto (85) | Assegnati al cliente "Cliente non indicato", creato dall'import | Il cliente è obbligatorio; l'ufficio può riassegnarli |
| Ordini cliente senza data (circa 19 500, tutti precedenti a ottobre 2018) | Data stimata: inizio della prima fase o collaudo dei suoi ordini di produzione; se non ce ne sono, la data dell'ordine cliente precedente per numerazione | La data è obbligatoria e serve per ordinare le liste |
| Fasi, fermi, lavori extra e collaudi rimasti aperti (1 244 fasi, 165 fermi, 37 lavori extra, 199 collaudi) | Chiusi senza aggiungere ore (vedi "Attività rimaste aperte") | Erano aperti dal 2018-2019 e risultavano ancora in corso |
| Particolari con materiale o fornitore inesistente (864, 153) | Materiale/fornitore vuoto | Riferimento a righe cancellate fisicamente |
| Composizione disegno con quantità 0 (6) | Quantità 1 | Il nuovo schema richiede quantità > 0 |
| Revisione disegno con spazi o caratteri strani | Spazi tolti; il resto conservato | |
| Collaudi di ordini inesistenti (23) | **Scartati** | L'ordine non esiste più nel vecchio DB |
| Ordini di produzione senza una riga ordine cliente univoca (circa 1 090) | `customer_order_line_id` vuoto | Riga assente o più righe con lo stesso disegno |
| Lavorazioni non concluse di ordini eliminati (20) | Eliminate logicamente | Regola del nuovo sistema: eliminando un ordine spariscono le lavorazioni non iniziate |
| Righe di coda taglio in attesa di ordini completati o eliminati | Eliminate logicamente | Stessa regola (sui dati attuali erano già tutte cancellate) |
| Fasi con fine lavorazione prima dell'inizio (3) | Conservate così come sono, contate | Sono registrazioni reali del tablet |
| Fasi del preventivo cancellate | Scartate | La tabella nuova non ha eliminazione logica |
| Utenti in `LEGACY_SKIP_USERS` o con email fuori dal dominio aziendale | Scartati | Non sono personale dell'officina |
| Preventivo e ordine cliente con codice che termina in "DiProva" | Rimossi | Creati per collaudare il vecchio software |

Tabelle **non importate**: reparto montaggi (`ordine_montaggio`, `fase_montaggio`, `collaudo_montaggio`,
`fermo_macchina_storico_montaggio`), `timbratura`, `orario_operatore`, `orario_sirena` (funzioni dismesse o mai
usate); `login` (solo l'ora di ingresso, senza uscita né postazione: diventerebbero sessioni del tablet aperte per
sempre); `resource` (riferimenti a file Excel non disponibili); preferenze, unità di misura, widget, gruppi utente,
`data_log`, `log`, `session`, impostazioni tecniche del vecchio sistema.

## Rilanciarlo su una copia aggiornata del database di produzione

I dati locali sono fermi a novembre 2019. Per il passaggio vero:

1. Fare un dump del database MySQL di produzione (`mysqldump --single-transaction --routines milocco_backoffice > dump.sql`),
   meglio a officina ferma, così non si perdono registrazioni del tablet fatte durante l'import.
2. Ripristinarlo su un MySQL raggiungibile dalla macchina dell'import:
   - con lo stesso nome (`milocco_backoffice`) sostituendo la copia vecchia, **oppure**
   - con un nome diverso (es. `milocco_backoffice_2026`) e impostare `LEGACY_DB_NAME` (e, se serve, host, porta,
     utente e password `LEGACY_DB_*`) nel file `.env`.
3. `npm run import:legacy -- --dry-run` e leggere il riepilogo: righe scartate o corrette in numero molto diverso da
   quanto descritto sopra vanno guardate prima di procedere (es. nuovi valori di stato non previsti, che vengono
   contati come "stato sconosciuto").
4. `npm run import:legacy` per l'import vero, poi `npm run check:schema`.
5. Impostare le password degli utenti (Amministrazione → Utenti) e caricare le giacenze iniziali delle barre
   (Anagrafiche → Magazzino barre: carico o rettifica per tipologia).

Se il vecchio sistema in produzione ha nuovi valori codificati (stati, priorità, unità), l'import non si ferma: li
converte nel valore predefinito e li conta nel riepilogo; in quel caso aggiungere la conversione in
`tools/import-legacy/src/importer.ts`.

## Testi con caratteri rovinati
Nel vecchio database alcuni testi sono salvati due volte in codifica (es. "Ø" appare come "Ã˜", "è" come "Ã¨").
L'import li corregge automaticamente su tutti i campi testo letti: la correzione si applica solo quando la
conversione inversa è senza perdite, altrimenti il testo resta com'è.

## Date non plausibili
Le date (solo giorno) precedenti al 1990 vengono importate vuote: nel vecchio database circa 545 ordini di
produzione hanno una consegna prevista nel 1901/1902, che li farebbe apparire in ritardo di decenni.
