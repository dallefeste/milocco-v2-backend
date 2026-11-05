import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService, writeAudit } from '../../common/crud/crud.service';
import { Customer, CustomerMachineRate, Machine } from '../../entities';
import { assertNotUsed } from './masterdata.common';
import { CustomerRateDto, UpdateCustomerRateDto } from './masterdata.dto';

@Injectable()
export class MachinesService extends CrudService<Machine> {
  constructor(
    @InjectRepository(Machine) repo: Repository<Machine>,
    @InjectRepository(CustomerMachineRate) private readonly rates: Repository<CustomerMachineRate>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
  ) {
    super(repo, {
      label: 'Macchina',
      relations: ['machineType'],
      searchFields: ['name', 'machineType.name'],
      sortable: ['name', 'machineType.name', 'hourlyRate', 'schedulable', 'sortOrder', 'createdAt'],
      filterable: ['machineTypeId', 'schedulable', 'machineType.isCutting', 'machineType.isInspection'],
      defaultSort: { field: 'sortOrder', order: 'asc' },
    });
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await assertNotUsed(this.repo.manager, [
      {
        sql: `SELECT 1 FROM schedule_item WHERE machine_id = $1 AND deleted_at IS NULL AND status <> 'DONE'`,
        params: [id],
        message: (n) => (n === 1 ? "Sulla macchina c'è 1 lavorazione pianificata non conclusa: spostala" : `Sulla macchina ci sono ${n} lavorazioni pianificate non concluse: spostale`) + " su un'altra macchina prima di eliminarla.",
      },
      {
        sql: `SELECT 1 FROM work_phase WHERE machine_id = $1 AND status = 'IN_PROGRESS' AND deleted_at IS NULL`,
        params: [id],
        message: () => 'Sulla macchina c\'è una fase in corso: si potrà eliminare quando sarà chiusa.',
      },
    ]);
    await super.remove(id);
  }

  // ------------------------------------------------------------ tariffe orarie per cliente

  /** Tariffe personalizzate della macchina (clienti eliminati esclusi), in ordine di nome cliente. */
  async listRates(machineId: number) {
    await this.findOne(machineId);
    return this.rates.createQueryBuilder('r')
      .innerJoinAndSelect('r.customer', 'c', 'c.deleted_at IS NULL')
      .where('r.machineId = :machineId', { machineId })
      .orderBy('c.name', 'ASC')
      .getMany();
  }

  private async getRate(machineId: number, rateId: number): Promise<CustomerMachineRate> {
    const rate = await this.rates.findOne({ where: { id: rateId, machineId }, relations: ['customer'] });
    if (!rate) throw new NotFoundException('Tariffa non trovata');
    return rate;
  }

  async addRate(machineId: number, dto: CustomerRateDto): Promise<CustomerMachineRate> {
    const machine = await this.findOne(machineId);
    const customer = await this.customers.findOne({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('Cliente non trovato');
    const existing = await this.rates.findOne({ where: { machineId, customerId: dto.customerId } });
    if (existing) {
      throw new ConflictException(`Per ${customer.name} c'è già una tariffa su ${machine.name}: modifica quella esistente.`);
    }
    const saved = await this.rates.save(this.rates.create({ machineId, customerId: dto.customerId, hourlyRate: dto.hourlyRate }));
    await writeAudit(this.rates.manager, 'customer_machine_rate', 'CREATE', saved.id, { machineId, ...dto });
    return this.getRate(machineId, saved.id);
  }

  async updateRate(machineId: number, rateId: number, dto: UpdateCustomerRateDto): Promise<CustomerMachineRate> {
    const rate = await this.getRate(machineId, rateId);
    rate.hourlyRate = dto.hourlyRate;
    await this.rates.save(rate);
    await writeAudit(this.rates.manager, 'customer_machine_rate', 'UPDATE', rateId, dto);
    return this.getRate(machineId, rateId);
  }

  /** Le tariffe sono configurazione (non storico): si eliminano davvero, con traccia nel registro. */
  async removeRate(machineId: number, rateId: number): Promise<void> {
    const rate = await this.getRate(machineId, rateId);
    await this.rates.delete(rate.id);
    await writeAudit(this.rates.manager, 'customer_machine_rate', 'DELETE', rateId, { machineId, customerId: rate.customerId, hourlyRate: rate.hourlyRate });
  }

  /**
   * Tariffa oraria da usare per un cliente (personalizzata se presente, altrimenti quella della macchina).
   * Per i preventivi.
   */
  async rateFor(machineId: number, customerId: number | null | undefined): Promise<number> {
    if (customerId) {
      const custom = await this.rates.findOne({ where: { machineId, customerId } });
      if (custom) return custom.hourlyRate;
    }
    const machine = await this.repo.findOne({ where: { id: machineId }, withDeleted: true });
    return machine?.hourlyRate ?? 0;
  }
}
