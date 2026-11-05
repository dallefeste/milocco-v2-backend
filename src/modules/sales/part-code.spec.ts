import { partInternalCode, revisionFromDescription, splitExcelCode } from './part-code';

describe('codice interno del particolare', () => {
  it('unisce codice e revisione', () => {
    expect(partInternalCode('12345', '01')).toBe('12345.01');
    expect(partInternalCode('12345', '')).toBe('12345.00');
  });
});

describe('revisione nella descrizione della riga Excel', () => {
  it.each([
    ['FLANGIA Rev.01', '01', 'FLANGIA'],
    ['PERNO R02', '02', 'PERNO'],
    ['PERNO rev 03', null, 'PERNO rev 03'],
    ['PERNO', null, 'PERNO'],
    ['VITE M8', null, 'VITE M8'], // prima diventava revisione "M8"
    ['BOCCOLA REV.AB', 'ab', 'BOCCOLA'],
    ['', null, ''],
  ])('"%s" → revisione %s', (descr, revision, name) => {
    expect(revisionFromDescription(descr)).toEqual({ revision, name });
  });
});

describe('codice della colonna C dell\'Excel', () => {
  it('accetta il codice con revisione scritto dall\'export', () => {
    expect(splitExcelCode('ABC123.01')).toEqual({ code: 'ABC123', revision: '01' });
    expect(splitExcelCode('ABC123')).toEqual({ code: 'ABC123', revision: null });
    expect(splitExcelCode('12.345.678')).toEqual({ code: '12.345.678', revision: null });
  });
});

import { cellNumber, parseTitle, resolveSlots } from './quote-excel-layout';

describe('layout Excel del preventivo', () => {
  it('legge il titolo in B2', () => {
    expect(parseTitle('ROSSI - SRL - ORDINE 7054 - Cons. 15/03/2026 - Riepilogo Tempi')).toEqual({ customer: 'ROSSI - SRL', number: '7054', delivery: '2026-03-15', errors: [] });
    expect(parseTitle('ROSSI - ORDINE 70 54 - Cons.  - Riepilogo').delivery).toBeNull();
    expect(parseTitle('titolo a caso').errors.length).toBe(1);
    expect(parseTitle('ROSSI - ORDINE 1 - Cons. 31/02/2026 - x').errors.length).toBe(1);
  });
  it('legge numeri scritti in vari modi', () => {
    expect(cellNumber(12)).toBe(12);
    expect(cellNumber('1,5')).toBe(1.5);
    expect(cellNumber({ formula: 'A1*2', result: 4 })).toBe(4);
    expect(cellNumber('')).toBeNull();
    expect(cellNumber('abc')).toBeNull();
  });
  it('assegna le tipologie alle colonne', () => {
    const byName = resolveSlots([{ id: 1, name: 'Tornitura', excelColumn: null }, { id: 7, name: 'Foratura', excelColumn: null }, { id: 9, name: 'Collaudo', excelColumn: null }]);
    expect(byName.get(1)).toBe('TORNITURA');
    expect(byName.get(7)).toBe('TRAPANATURA');
    expect(byName.has(9)).toBe(false);
    const configured = resolveSlots([{ id: 1, name: 'Tornitura', excelColumn: null }, { id: 2, name: 'Fresa CNC', excelColumn: 'fresatura' }]);
    expect(configured.has(1)).toBe(false);
    expect(configured.get(2)).toBe('FRESATURA');
    const real = resolveSlots([{ id: 7, name: 'foratura', excelColumn: 'FORATURA' }, { id: 3, name: 'Rettifica', excelColumn: 'RETTIFICA' }, { id: 1, name: 'tornitura', excelColumn: 'TORNITURA' }]);
    expect(real.get(7)).toBe('TRAPANATURA');
    expect(real.has(3)).toBe(false);
    expect(real.get(1)).toBe('TORNITURA');
  });
});
