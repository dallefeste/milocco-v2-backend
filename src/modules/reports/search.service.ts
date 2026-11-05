import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { UserRole } from '../../shared';
import { PRODUCTION_ORDER_STATUS_LABELS, type ProductionOrderStatus } from '../../shared';
import { drawingLabel } from './report-utils';

export interface SearchHit {
  type: 'productionOrder' | 'customerOrder' | 'drawing' | 'part' | 'customer' | 'quote';
  typeLabel: string;
  id: number;
  title: string;
  subtitle?: string;
  to: string;
}

const MAX_RESULTS = 20;
const PER_TYPE = 6;

/** Escape dei caratteri speciali di LIKE. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Ricerca globale (Ctrl+K). Risultati esatti prima, poi quelli che iniziano con il testo, poi quelli che
 * lo contengono; al massimo 20 in tutto. I preventivi solo per gli amministratori.
 */
@Injectable()
export class SearchService {
  constructor(private readonly ds: DataSource) {}

  async search(qRaw: string | undefined, role: UserRole): Promise<SearchHit[]> {
    const q = (qRaw ?? '').trim();
    if (q.length < 2) return [];
    const like = `%${likeEscape(q.toLowerCase())}%`;
    const prefix = `${likeEscape(q.toLowerCase())}%`;
    const lower = q.toLowerCase();
    const numeric = /^[1-9]\d{0,8}$/.test(q) ? Number(q) : null;
    const rank = (expr: string) => `CASE WHEN lower(${expr}) = $2 THEN 0 WHEN lower(${expr}) LIKE $3 THEN 1 ELSE 2 END`;

    const tasks: Promise<SearchHit[]>[] = [];

    if (numeric !== null && numeric < 2_147_483_647) {
      tasks.push(
        this.ds
          .query(
            `SELECT po.id, po.status, po.quantity, d.code, d.revision, c.name AS customer_name, co.code AS co_code
               FROM production_order po JOIN drawing d ON d.id = po.drawing_id
               JOIN customer_order co ON co.id = po.customer_order_id JOIN customer c ON c.id = co.customer_id
              WHERE po.deleted_at IS NULL AND (po.id = $1 OR po.id::text LIKE $2)
              ORDER BY (po.id = $1) DESC, po.id DESC LIMIT ${PER_TYPE}`,
            [numeric, `${q}%`],
          )
          .then((rows: any[]) =>
            rows.map((r) => ({
              type: 'productionOrder' as const,
              typeLabel: 'Ordine produzione',
              id: r.id,
              title: `Ordine ${r.id} · ${drawingLabel(r.code, r.revision)}`,
              subtitle: `${r.customer_name} · ordine cliente ${r.co_code} · ${r.quantity} pz · ${PRODUCTION_ORDER_STATUS_LABELS[r.status as ProductionOrderStatus] ?? r.status}`,
              to: `/produzione/ordini/${r.id}`,
            })),
          ),
      );
    }

    tasks.push(
      this.ds
        .query(
          `SELECT co.id, co.code, co.order_date, c.name AS customer_name
             FROM customer_order co JOIN customer c ON c.id = co.customer_id
            WHERE co.deleted_at IS NULL AND lower(co.code) LIKE $1
            ORDER BY ${rank('co.code')}, co.order_date DESC LIMIT ${PER_TYPE}`,
          [like, lower, prefix],
        )
        .then((rows: any[]) =>
          rows.map((r) => ({ type: 'customerOrder' as const, typeLabel: 'Ordine cliente', id: r.id, title: r.code, subtitle: `${r.customer_name} · ${new Date(r.order_date).toLocaleDateString('it-IT')}`, to: `/commerciale/ordini-cliente/${r.id}` })),
        ),
      this.ds
        .query(
          `SELECT d.id, d.code, d.revision, d.name FROM drawing d
            WHERE d.deleted_at IS NULL AND lower(d.code) LIKE $1
            ORDER BY ${rank('d.code')}, d.code, d.revision DESC LIMIT ${PER_TYPE}`,
          [like, lower, prefix],
        )
        .then((rows: any[]) => rows.map((r) => ({ type: 'drawing' as const, typeLabel: 'Disegno', id: r.id, title: drawingLabel(r.code, r.revision), subtitle: r.name || undefined, to: `/tecnico/disegni/${r.id}` }))),
      this.ds
        .query(
          `SELECT p.id, p.internal_code, p.name, p.dimensions FROM part p
            WHERE p.deleted_at IS NULL AND lower(p.internal_code) LIKE $1
            ORDER BY ${rank('p.internal_code')}, p.internal_code LIMIT ${PER_TYPE}`,
          [like, lower, prefix],
        )
        .then((rows: any[]) =>
          rows.map((r) => ({ type: 'part' as const, typeLabel: 'Particolare', id: r.id, title: r.internal_code, subtitle: [r.name, r.dimensions].filter(Boolean).join(' · ') || undefined, to: `/tecnico/particolari/${r.id}` })),
        ),
      this.ds
        .query(
          `SELECT c.id, c.name FROM customer c
            WHERE c.deleted_at IS NULL AND lower(c.name) LIKE $1
            ORDER BY ${rank('c.name')}, c.name LIMIT ${PER_TYPE}`,
          [like, lower, prefix],
        )
        .then((rows: any[]) =>
          rows.map((r) => ({ type: 'customer' as const, typeLabel: 'Cliente', id: r.id, title: r.name, subtitle: 'Anagrafica cliente', to: `/anagrafiche/clienti?search=${encodeURIComponent(r.name)}` })),
        ),
    );

    if (role === 'ADMIN') {
      tasks.push(
        this.ds
          .query(
            `SELECT qt.id, qt.number, qt.issue_date::text AS issue_date, c.name AS customer_name FROM quote qt JOIN customer c ON c.id = qt.customer_id
              WHERE qt.deleted_at IS NULL AND lower(qt.number) LIKE $1
              ORDER BY ${rank('qt.number')}, qt.issue_date DESC LIMIT ${PER_TYPE}`,
            [like, lower, prefix],
          )
          .then((rows: any[]) => rows.map((r) => ({ type: 'quote' as const, typeLabel: 'Preventivo', id: r.id, title: r.number, subtitle: `${r.customer_name} · ${r.issue_date}`, to: `/commerciale/preventivi/${r.id}` }))),
      );
    }

    const groups = await Promise.all(tasks);
    // Alterna i gruppi così che ogni tipo abbia spazio nei 20 risultati, rispettando l'ordine interno.
    const out: SearchHit[] = [];
    for (let i = 0; out.length < MAX_RESULTS && groups.some((g) => g.length > i); i++) {
      for (const g of groups) if (g[i] && out.length < MAX_RESULTS) out.push(g[i]);
    }
    // Riordina per tipo mantenendo i primi risultati di ciascuno.
    const order = ['productionOrder', 'customerOrder', 'drawing', 'part', 'customer', 'quote'];
    return out.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  }
}
