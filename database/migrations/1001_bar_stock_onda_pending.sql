-- Magazzino barre: giacenza modificata nel gestionale ma non ancora scritta su Onda
-- (Onda spento o non raggiungibile al momento del movimento). La sincronizzazione successiva
-- scrive su Onda il valore locale invece di sovrascriverlo con quello di Onda.
ALTER TABLE bar_stock ADD COLUMN onda_pending boolean NOT NULL DEFAULT false;
