import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { Brackets, Repository } from 'typeorm';
import { WEEKDAY_LABELS } from '../../shared';
import { writeAudit } from '../../common/crud/crud.service';
import { ListQueryDto, Paginated } from '../../common/crud/list-query.dto';
import { WorkCalendarClosure, WorkCalendarDay } from '../../entities';
import { CreateClosureDto, UpdateClosureDto, WorkCalendarDayDto } from './masterdata.dto';

/** Orario di un giorno di calendario, calcolato da orario settimanale e chiusure straordinarie. */
export interface WorkDayInfo {
  /** Giorno 'YYYY-MM-DD' nel fuso orario dello stabilimento. */
  date: string;
  /** 0 = lunedì … 6 = domenica */
  weekday: number;
  /** Giorno lavorativo: orario impostato e nessuna chiusura straordinaria. */
  working: boolean;
  /** Orario settimanale del giorno ('HH:MM:SS'), anche se c'è una chiusura straordinaria. */
  startTime: string | null;
  endTime: string | null;
  /** Inizio e fine come istanti (null se non lavorativo). */
  start: Date | null;
  end: Date | null;
  /** Secondi lavorativi del giorno (0 se non lavorativo). */
  seconds: number;
  /** Motivo della chiusura straordinaria, se il giorno è chiuso per questo. */
  closureReason: string | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const normTime = (t: string | null | undefined) => (t ? (t.length === 5 ? `${t}:00` : t) : null);
const toSec = (t: string) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
/** 0 = lunedì … 6 = domenica, da una data 'YYYY-MM-DD'. */
const weekdayOf = (day: string) => { const [y, m, d] = day.split('-').map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; };
const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/**
 * Orario di lavoro dello stabilimento: 7 giorni della settimana più chiusure straordinarie.
 * Esportato dal modulo: la pianificazione usa getDay()/getDays()/nextWorkingDay().
 */
@Injectable()
export class WorkCalendarService {
  private weekCache: WorkCalendarDay[] | null = null;
  private closureCache = new Map<string, string | null>();
  private closuresLoaded = false;

  constructor(
    @InjectRepository(WorkCalendarDay) private readonly days: Repository<WorkCalendarDay>,
    @InjectRepository(WorkCalendarClosure) private readonly closures: Repository<WorkCalendarClosure>,
    private readonly config: ConfigService,
  ) {}

  get timezone(): string {
    return this.config.get<string>('timezone') ?? 'Europe/Rome';
  }

  private invalidate() {
    this.weekCache = null;
    this.closureCache.clear();
    this.closuresLoaded = false;
  }

  // ------------------------------------------------------------ orario settimanale

  async getWeek(): Promise<(WorkCalendarDay & { label: string; closed: boolean; seconds: number })[]> {
    const rows = await this.loadWeek();
    return rows.map((d) => ({
      ...d,
      label: WEEKDAY_LABELS[d.weekday],
      closed: !d.startTime || !d.endTime,
      seconds: d.startTime && d.endTime ? toSec(d.endTime) - toSec(d.startTime) : 0,
    }));
  }

  private async loadWeek(): Promise<WorkCalendarDay[]> {
    if (!this.weekCache) {
      const rows = await this.days.find({ order: { weekday: 'ASC' } });
      // Le 7 righe sono create dalla migrazione; per sicurezza le giornate mancanti valgono come chiuse.
      this.weekCache = Array.from({ length: 7 }, (_, i) => rows.find((r) => r.weekday === i) ?? Object.assign(new WorkCalendarDay(), { weekday: i, startTime: null, endTime: null }));
    }
    return this.weekCache;
  }

  private normalizeDay(weekday: number, dto: WorkCalendarDayDto): { startTime: string | null; endTime: string | null } {
    const label = WEEKDAY_LABELS[weekday];
    if (dto.closed || (!dto.startTime && !dto.endTime)) return { startTime: null, endTime: null };
    const startTime = normTime(dto.startTime);
    const endTime = normTime(dto.endTime);
    if (!startTime || !endTime) throw new BadRequestException(`${label}: indica sia l'ora di inizio sia quella di fine, oppure segna il giorno come chiuso.`);
    if (toSec(endTime) <= toSec(startTime)) throw new BadRequestException(`${label}: l'ora di fine deve essere dopo l'ora di inizio.`);
    return { startTime, endTime };
  }

  async updateDay(weekday: number, dto: WorkCalendarDayDto) {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new NotFoundException('Giorno non valido (0 = lunedì … 6 = domenica)');
    const values = this.normalizeDay(weekday, dto);
    await this.days.manager.transaction(async (em) => {
      await em.upsert(WorkCalendarDay, { weekday, ...values }, ['weekday']);
      await writeAudit(em, 'work_calendar_day', 'UPDATE', weekday, values, `Orario di ${WEEKDAY_LABELS[weekday]}`);
    });
    this.invalidate();
    return this.getWeek();
  }

  async updateWeek(list: WorkCalendarDayDto[]) {
    const byDay = list.map((d, i) => ({ weekday: d.weekday ?? i, dto: d }));
    const seen = new Set(byDay.map((d) => d.weekday));
    if (seen.size !== 7 || byDay.some((d) => d.weekday < 0 || d.weekday > 6)) throw new BadRequestException('Servono i 7 giorni della settimana, da lunedì a domenica.');
    const values = byDay.map((d) => ({ weekday: d.weekday, ...this.normalizeDay(d.weekday, d.dto) }));
    if (values.every((v) => !v.startTime)) throw new BadRequestException('Almeno un giorno della settimana deve essere lavorativo.');
    await this.days.manager.transaction(async (em) => {
      for (const v of values) await em.upsert(WorkCalendarDay, v, ['weekday']);
      await writeAudit(em, 'work_calendar_day', 'UPDATE', 'settimana', values, 'Orario settimanale');
    });
    this.invalidate();
    return this.getWeek();
  }

  // ------------------------------------------------------------ chiusure straordinarie

  /** Elenco chiusure; filter[period] = 'future' (da oggi in poi) o 'past'. */
  async listClosures(query: ListQueryDto): Promise<Paginated<WorkCalendarClosure>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const qb = this.closures.createQueryBuilder('c');
    const today = this.today();
    const period = query.filter?.period;
    if (period === 'future') qb.andWhere('c.day >= :today', { today });
    if (period === 'past') qb.andWhere('c.day < :today', { today });
    if (query.search) {
      const term = `%${query.search.trim()}%`;
      qb.andWhere(new Brackets((w) => w.where('c.reason ILIKE :term', { term }).orWhere('CAST(c.day AS text) ILIKE :term', { term })));
    }
    const order = query.order === 'desc' ? 'DESC' : query.order === 'asc' ? 'ASC' : period === 'past' ? 'DESC' : 'ASC';
    qb.orderBy(query.sort === 'reason' ? 'c.reason' : 'c.day', order);
    const [items, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    return { items, total, page, pageSize };
  }

  async getClosure(id: number): Promise<WorkCalendarClosure> {
    const row = await this.closures.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Chiusura non trovata');
    return row;
  }

  /** Crea una chiusura o un periodo di chiusura (un giorno per riga); i giorni già chiusi vengono saltati. */
  async createClosure(dto: CreateClosureDto): Promise<WorkCalendarClosure> {
    const from = dto.day.slice(0, 10);
    const to = (dto.toDay ?? dto.day).slice(0, 10);
    if (to < from) throw new BadRequestException('La data di fine deve essere uguale o successiva a quella di inizio.');
    const daysList: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) daysList.push(d);
    if (daysList.length > 366) throw new BadRequestException('Periodo troppo lungo: al massimo un anno.');
    const existing = new Set((await this.closures.createQueryBuilder('c').where('c.day BETWEEN :from AND :to', { from, to }).getMany()).map((c) => c.day));
    const toCreate = daysList.filter((d) => !existing.has(d));
    if (toCreate.length === 0) throw new ConflictException(daysList.length === 1 ? `Il ${from} è già un giorno di chiusura.` : 'Tutti i giorni del periodo sono già chiusi.');
    const created = await this.closures.manager.transaction(async (em) => {
      const rows = await em.save(toCreate.map((day) => em.create(WorkCalendarClosure, { day, reason: dto.reason ?? null })));
      await writeAudit(em, 'work_calendar_closure', 'CREATE', rows[0].id, { from, to, reason: dto.reason ?? null, days: rows.length });
      return rows;
    });
    this.invalidate();
    return created[0];
  }

  async updateClosure(id: number, dto: UpdateClosureDto): Promise<WorkCalendarClosure> {
    const row = await this.getClosure(id);
    if (dto.day && dto.day.slice(0, 10) !== row.day) {
      const other = await this.closures.findOne({ where: { day: dto.day.slice(0, 10) } });
      if (other) throw new ConflictException(`Il ${dto.day.slice(0, 10)} è già un giorno di chiusura.`);
      row.day = dto.day.slice(0, 10);
    }
    if (dto.reason !== undefined) row.reason = dto.reason ?? null;
    await this.closures.save(row);
    await writeAudit(this.closures.manager, 'work_calendar_closure', 'UPDATE', id, dto);
    this.invalidate();
    return this.getClosure(id);
  }

  /** Le chiusure sono configurazione: si eliminano davvero (traccia nel registro modifiche). */
  async removeClosure(id: number): Promise<void> {
    const row = await this.getClosure(id);
    await this.closures.delete(id);
    await writeAudit(this.closures.manager, 'work_calendar_closure', 'DELETE', id, { day: row.day, reason: row.reason });
    this.invalidate();
  }

  // ------------------------------------------------------------ servizio per la pianificazione

  /** Data di oggi 'YYYY-MM-DD' nel fuso orario dello stabilimento. */
  today(): string {
    return this.dayOf(new Date());
  }

  /** Giorno di calendario 'YYYY-MM-DD' di un istante, nel fuso orario dello stabilimento. */
  dayOf(instant: Date): string {
    return formatInTimeZone(instant, this.timezone, 'yyyy-MM-dd');
  }

  private async loadClosures(): Promise<void> {
    if (this.closuresLoaded) return;
    const rows = await this.closures.find();
    this.closureCache = new Map(rows.map((r) => [r.day, r.reason]));
    this.closuresLoaded = true;
  }

  /**
   * Orario di un giorno. Accetta 'YYYY-MM-DD' oppure un istante (Date): in questo caso vale il giorno
   * di calendario dell'istante nel fuso orario dello stabilimento.
   */
  async getDay(date: string | Date): Promise<WorkDayInfo> {
    const day = typeof date === 'string' ? date.slice(0, 10) : this.dayOf(date);
    if (!DAY_RE.test(day)) throw new BadRequestException(`Data non valida: ${date}`);
    const week = await this.loadWeek();
    await this.loadClosures();
    const weekday = weekdayOf(day);
    const { startTime, endTime } = week[weekday];
    const closed = this.closureCache.has(day);
    const working = !!startTime && !!endTime && !closed;
    const start = working ? fromZonedTime(`${day}T${startTime}`, this.timezone) : null;
    const end = working ? fromZonedTime(`${day}T${endTime}`, this.timezone) : null;
    return {
      date: day,
      weekday,
      working,
      startTime,
      endTime,
      start,
      end,
      seconds: start && end ? Math.round((end.getTime() - start.getTime()) / 1000) : 0,
      closureReason: closed ? (this.closureCache.get(day) ?? 'Chiusura straordinaria') : null,
    };
  }

  /** Orari dei giorni da `from` a `to` compresi (massimo 3 anni). */
  async getDays(from: string | Date, to: string | Date): Promise<WorkDayInfo[]> {
    const a = typeof from === 'string' ? from.slice(0, 10) : this.dayOf(from);
    const b = typeof to === 'string' ? to.slice(0, 10) : this.dayOf(to);
    const out: WorkDayInfo[] = [];
    for (let d = a; d <= b && out.length < 1100; d = addDays(d, 1)) out.push(await this.getDay(d));
    return out;
  }

  async isWorkingDay(date: string | Date): Promise<boolean> {
    return (await this.getDay(date)).working;
  }

  /**
   * Primo giorno lavorativo a partire da `date` (compreso se `inclusive`).
   * Errore se nei prossimi 3 anni non ce n'è nessuno (orario settimanale tutto chiuso).
   */
  async nextWorkingDay(date: string | Date, inclusive = true): Promise<WorkDayInfo> {
    let d = typeof date === 'string' ? date.slice(0, 10) : this.dayOf(date);
    if (!inclusive) d = addDays(d, 1);
    for (let i = 0; i < 1100; i++, d = addDays(d, 1)) {
      const info = await this.getDay(d);
      if (info.working) return info;
    }
    throw new BadRequestException("Nessun giorno lavorativo nell'orario di lavoro: controlla Anagrafiche → Orario di lavoro.");
  }
}
