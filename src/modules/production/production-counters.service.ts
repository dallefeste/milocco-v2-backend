import { Injectable } from '@nestjs/common';
import { CutService } from './cut/cut.service';
import { ProductionOrdersService } from './orders/production-orders.service';
import { WorkPhasesService } from './shop/shop-records.service';

/**
 * Contatori dell'area produzione per i badge del menu e il cruscotto (`GET /dashboard/counters`):
 * `lateOrders` (ordini non completati con consegna passata), `cutToApprove` (particolari da approvare
 * per il taglio), `openPhases` (fasi aperte in reparto).
 */
@Injectable()
export class ProductionCountersService {
  constructor(
    private readonly orders: ProductionOrdersService,
    private readonly cut: CutService,
    private readonly phases: WorkPhasesService,
  ) {}

  lateOrders(): Promise<number> { return this.orders.countLate(); }
  cutToApprove(): Promise<number> { return this.cut.countToApprove(); }
  openPhases(): Promise<number> { return this.phases.countOpen(); }

  async counters(): Promise<{ lateOrders: number; cutToApprove: number; openPhases: number }> {
    const [lateOrders, cutToApprove, openPhases] = await Promise.all([this.lateOrders(), this.cutToApprove(), this.openPhases()]);
    return { lateOrders, cutToApprove, openPhases };
  }
}
