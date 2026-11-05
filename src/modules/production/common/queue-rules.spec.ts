import { computeCutAvailability, provisionalPosition, splitDimensions } from './queue-rules';

/** Simula una coda: applica la posizione provvisoria e rinumera 1..n. */
function move(queue: string[], item: string, to: number | null): string[] {
  const ranks = new Map(queue.map((q, i) => [q, i + 1] as [string, number]));
  const pos = provisionalPosition({ requested: to, currentRank: ranks.get(item), maxPosition: queue.length });
  const values = queue.filter((q) => q !== item).map((q) => [q, ranks.get(q)!] as [string, number]);
  values.push([item, pos]);
  return values.sort((a, b) => a[1] - b[1]).map(([q]) => q);
}

describe('posizioni nelle code (§4.4)', () => {
  const q = ['A', 'B', 'C', 'D'];
  it("esempio della specifica: A in posizione 3 → B C A D", () => expect(move(q, 'A', 3)).toEqual(['B', 'C', 'A', 'D']));
  it('spostamento verso l alto', () => expect(move(q, 'D', 2)).toEqual(['A', 'D', 'B', 'C']));
  it('in testa', () => expect(move(q, 'C', 1)).toEqual(['C', 'A', 'B', 'D']));
  it('in fondo', () => expect(move(q, 'A', 4)).toEqual(['B', 'C', 'D', 'A']));
  it('stessa posizione: invariato', () => expect(move(q, 'B', 2)).toEqual(q));
  it('nuovo elemento in posizione 2 o in fondo', () => {
    expect(move(q, 'E', 2)).toEqual(['A', 'E', 'B', 'C', 'D']);
    expect(move(q, 'E', null)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});

describe('disponibilità materiale nella coda di taglio (§5.5)', () => {
  const stock = new Map([[1, 10], [2, 0.5]]);
  it('prenota la giacenza in ordine di coda e non si interrompe sulle righe incomplete', () => {
    const res = computeCutAvailability(
      [
        { id: 1, barTypeId: 1, cutLengthMm: 100, orderQuantity: 20, quantityPerUnit: 2 }, // 4 m
        { id: 2, barTypeId: null, cutLengthMm: 100, orderQuantity: 1, quantityPerUnit: 1 },
        { id: 3, barTypeId: 1, cutLengthMm: null, orderQuantity: 1, quantityPerUnit: 1 },
        { id: 4, barTypeId: 1, cutLengthMm: 250, orderQuantity: 20, quantityPerUnit: 1 }, // 5 m, restano 6
        { id: 5, barTypeId: 1, cutLengthMm: 250, orderQuantity: 20, quantityPerUnit: 1 }, // 5 m, ne resta 1
        { id: 6, barTypeId: 1, cutLengthMm: 50, orderQuantity: 20, quantityPerUnit: 1 }, // 1 m, ne resta 1 → ok
        { id: 7, barTypeId: 3, cutLengthMm: 50, orderQuantity: 1, quantityPerUnit: 1 }, // nessuna giacenza
      ],
      stock,
    );
    expect(res.get(1)).toEqual({ state: 'AVAILABLE', neededMeters: 4, availableMeters: 10 });
    expect(res.get(2)?.state).toBe('NO_BAR_TYPE');
    expect(res.get(3)?.state).toBe('NO_LENGTH');
    expect(res.get(4)).toEqual({ state: 'AVAILABLE', neededMeters: 5, availableMeters: 6 });
    expect(res.get(5)).toEqual({ state: 'INSUFFICIENT', neededMeters: 5, availableMeters: 1 });
    expect(res.get(6)).toEqual({ state: 'AVAILABLE', neededMeters: 1, availableMeters: 1 });
    expect(res.get(7)).toEqual({ state: 'INSUFFICIENT', neededMeters: 0.05, availableMeters: 0 });
  });
});

describe('testo dimensioni', () => {
  it('separa forma e misure', () => {
    expect(splitDimensions('Barra circolare - d50 L43')).toEqual({ shape: 'Barra circolare', size: 'd50 L43' });
    expect(splitDimensions('A Disegno')).toEqual({ shape: null, size: 'A Disegno' });
    expect(splitDimensions(null)).toEqual({ shape: null, size: null });
  });
});
