import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { customerOrderStatsSql } from './customer-order-sql';

/**
 * Contatori dell'area commerciale per i badge del menu e la home (`GET /dashboard/counters`).
 * Esportato da SalesModule: l'area report lo usa senza conoscere le regole di stato.
 */
@Injectable()
export class SalesCountersService {
  constructor(private readonly dataSource: DataSource) {}

  /** Ordini cliente con righe pronte da confermare (stato "Da confermare" o "Parzialmente confermato"). */
  async customerOrdersToConfirm(): Promise<number> {
    const rows: { n: number }[] = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM (${customerOrderStatsSql}) x WHERE x.status IN ('TO_CONFIRM', 'PARTIALLY_CONFIRMED')`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Tutti i contatori dell'area, nel formato di `/dashboard/counters`. */
  async counters(): Promise<{ customerOrdersToConfirm: number }> {
    return { customerOrdersToConfirm: await this.customerOrdersToConfirm() };
  }
}
