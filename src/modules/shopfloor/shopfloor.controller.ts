import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { LoginResponse } from '../../shared';
import { Public, Roles } from '../../common/auth/decorators';
import { OperatorsService } from '../masterdata/operators.service';
import { UsersService } from '../users/users.service';
import { ShopfloorActionsService } from './shopfloor-actions.service';
import { ShopfloorReadService } from './shopfloor-read.service';
import {
  AvgTimeDto, BarMoveDto, DeviceLoginDto, ExtraStartDto, InspectionDataDto, InspectionStartDto, SetupStartDto, StartSessionDto,
  StateQueryDto, StopStartDto, SubgroupQueryDto, SuspendDto, WorkEndDto,
} from './shopfloor.dto';

/** Durata del token del dispositivo tablet. */
const DEVICE_TOKEN_DAYS = 365;

/**
 * API dell'app tablet di reparto (ruolo TABLET). Tutte le azioni sono transazionali, controllano lo stato e
 * tollerano il doppio invio. Gli orari li decide il server.
 */
@ApiTags('Tablet di reparto')
@ApiBearerAuth()
@Roles('TABLET')
@Controller('shopfloor')
export class ShopfloorController {
  constructor(
    private readonly read: ShopfloorReadService,
    private readonly actions: ShopfloorActionsService,
    private readonly users: UsersService,
    private readonly operatorsService: OperatorsService,
    private readonly jwt: JwtService,
  ) {}

  // ---------------------------------------------------------------- dispositivo e sessione

  /** Configurazione del tablet: accesso con un utente di tipo "Tablet di reparto", token valido un anno. */
  @Public()
  @Post('device-login')
  @HttpCode(200)
  async deviceLogin(@Body() dto: DeviceLoginDto): Promise<LoginResponse> {
    const user = await this.users.validateCredentials(dto.username, dto.password);
    if (user.role !== 'TABLET') {
      throw new ForbiddenException('Per configurare il tablet serve un utente di tipo "Tablet di reparto" (si crea dal backoffice, Amministrazione → Utenti)');
    }
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, username: user.username, role: user.role },
      { expiresIn: `${DEVICE_TOKEN_DAYS}d` },
    );
    return {
      accessToken,
      user: { id: user.id, username: user.username, firstName: user.firstName, lastName: user.lastName, role: user.role, mustChangePassword: false },
    };
  }

  /** Ora del server: il tablet allinea il suo orologio a questa. */
  @Public()
  @Get('time')
  time() {
    return { now: new Date().toISOString() };
  }

  @Get('stations')
  stations() {
    return this.read.stations();
  }

  @Get('stations/:id')
  station(@Param('id', ParseIntPipe) id: number) {
    return this.read.station(id);
  }

  @Get('operators')
  operators() {
    return this.read.operators();
  }

  /** Inizio sessione dell'operatore sulla postazione (verifica il PIN se l'operatore ne ha uno). */
  @Post('sessions')
  @HttpCode(200)
  async startSession(@Body() dto: StartSessionDto) {
    const { exists, pinHash } = await this.read.operatorPinHash(dto.operatorId);
    if (!exists) throw new BadRequestException('Operatore non attivo: scegli di nuovo l\'operatore');
    if (pinHash) {
      if (!dto.pin) throw new BadRequestException('Inserisci il PIN');
      if (!(await this.operatorsService.verifyPin(dto.operatorId, dto.pin))) {
        await new Promise((r) => setTimeout(r, 500));
        throw new BadRequestException('PIN non corretto');
      }
    }
    const session = await this.actions.startSession(dto.operatorId, dto.machineId);
    return { sessionId: session.id, startedAt: session.startedAt };
  }

  @Post('sessions/:id/end')
  @HttpCode(200)
  async endSession(@Param('id', ParseIntPipe) id: number) {
    const s = await this.actions.endSession(id);
    return { sessionId: s.id, endedAt: s.endedAt };
  }

  /** Attività aperte di operatore e postazione, per riprendere dopo un ricaricamento. */
  @Get('state')
  state(@Query() q: StateQueryDto) {
    return this.read.state(q.machineId, q.operatorId);
  }

  // ---------------------------------------------------------------- scelta del lavoro

  @Get('machines/:id/next')
  async next(@Param('id', ParseIntPipe) id: number) {
    return { next: await this.read.nextPlanned(id) };
  }

  @Get('customers')
  customers() {
    return this.read.customers();
  }

  @Get('customers/:id/subgroups')
  subgroups(@Param('id', ParseIntPipe) id: number) {
    return this.read.subgroups(id);
  }

  @Get('customers/:id/orders')
  orders(@Param('id', ParseIntPipe) id: number, @Query() q: SubgroupQueryDto) {
    return this.read.orders(id, q.subgroup);
  }

  @Get('orders/:id/parts')
  orderParts(@Param('id', ParseIntPipe) id: number) {
    return this.read.orderParts(id);
  }

  @Get('orders/:id/parts/:partId/summary')
  orderSummary(@Param('id', ParseIntPipe) id: number, @Param('partId', ParseIntPipe) partId: number) {
    return this.read.orderSummary(id, partId);
  }

  @Get('orders/:id/inspection-summary')
  inspectionSummary(@Param('id', ParseIntPipe) id: number) {
    return this.read.inspectionSummary(id);
  }

  @Get('stop-reasons')
  stopReasons() {
    return this.read.stopReasons();
  }

  @Get('extra-activities')
  extraActivities() {
    return this.read.extraActivities();
  }

  // ---------------------------------------------------------------- fasi

  /** Fase con ordine, particolare e fermo aperto (schermate attrezzaggio, lavorazione, fermo). */
  @Get('phases/:id')
  phase(@Param('id', ParseIntPipe) id: number) {
    return this.read.activePhase(id);
  }

  @Post('phases/setup-start')
  @HttpCode(200)
  async setupStart(@Body() dto: SetupStartDto) {
    const phase = await this.actions.setupStart(dto);
    return this.read.activePhase(phase.id);
  }

  @Post('phases/:id/setup-end')
  @HttpCode(200)
  async setupEnd(@Param('id', ParseIntPipe) id: number) {
    await this.actions.setupEnd(id);
    return this.read.activePhase(id);
  }

  @Post('phases/:id/work-start')
  @HttpCode(200)
  async workStart(@Param('id', ParseIntPipe) id: number) {
    await this.actions.workStart(id);
    return this.read.activePhase(id);
  }

  @Post('phases/:id/work-end')
  @HttpCode(200)
  async workEnd(@Param('id', ParseIntPipe) id: number, @Body() dto: WorkEndDto) {
    await this.actions.workEnd(id, dto);
    return this.read.activePhase(id);
  }

  @Post('phases/:id/suspend')
  @HttpCode(200)
  async suspend(@Param('id', ParseIntPipe) id: number, @Body() dto: SuspendDto) {
    await this.actions.suspend(id, dto);
    return this.read.activePhase(id);
  }

  @Post('phases/:id/avg-time')
  @HttpCode(200)
  async avgTime(@Param('id', ParseIntPipe) id: number, @Body() dto: AvgTimeDto) {
    await this.actions.saveAvgTime(id, dto.avgUnitSeconds);
    return this.read.activePhase(id);
  }

  @Post('phases/:id/stops')
  @HttpCode(200)
  async stopStart(@Param('id', ParseIntPipe) id: number, @Body() dto: StopStartDto) {
    const r = await this.actions.stopStart(id, dto);
    return { suspended: r.suspended, stop: await this.read.stopById(r.stop.id), active: await this.read.activePhase(id) };
  }

  @Post('stops/:id/end')
  @HttpCode(200)
  async stopEnd(@Param('id', ParseIntPipe) id: number) {
    const stop = await this.actions.stopEnd(id);
    return this.read.activePhase(stop.workPhaseId);
  }

  // ---------------------------------------------------------------- lavori extra

  @Get('extra-activities/:id')
  extra(@Param('id', ParseIntPipe) id: number) {
    return this.read.extraById(id);
  }

  @Post('extra-activities/start')
  @HttpCode(200)
  async extraStart(@Body() dto: ExtraStartDto) {
    const log = await this.actions.extraStart(dto);
    return this.read.extraById(log.id);
  }

  @Post('extra-activities/:id/end')
  @HttpCode(200)
  async extraEnd(@Param('id', ParseIntPipe) id: number) {
    const log = await this.actions.extraEnd(id);
    return { id: log.id, endedAt: log.endedAt };
  }

  // ---------------------------------------------------------------- collaudo

  @Get('inspections/:id')
  inspection(@Param('id', ParseIntPipe) id: number) {
    return this.read.inspectionById(id);
  }

  @Post('inspections/start')
  @HttpCode(200)
  async inspectionStart(@Body() dto: InspectionStartDto) {
    const i = await this.actions.inspectionStart(dto);
    return this.read.inspectionById(i.id);
  }

  @Post('inspections/:id/end')
  @HttpCode(200)
  async inspectionEnd(@Param('id', ParseIntPipe) id: number) {
    await this.actions.inspectionEnd(id);
    return this.read.inspectionById(id);
  }

  @Post('inspections/:id/data')
  @HttpCode(200)
  async inspectionData(@Param('id', ParseIntPipe) id: number, @Body() dto: InspectionDataDto) {
    await this.actions.inspectionData(id, dto);
    return this.read.inspectionById(id);
  }

  @Post('orders/:id/archive')
  @HttpCode(200)
  async archive(@Param('id', ParseIntPipe) id: number) {
    const order = await this.actions.archiveOrder(id);
    return { productionOrderId: order.id, status: order.status, completedAt: order.completedAt };
  }

  // ---------------------------------------------------------------- taglio e magazzino barre

  @Get('cut-queue')
  cutQueue() {
    return this.read.cutQueue();
  }

  @Get('bar-types')
  barTypes() {
    return this.read.barTypes();
  }

  @Get('bar-stock/:barTypeId')
  barStock(@Param('barTypeId', ParseIntPipe) barTypeId: number) {
    return this.read.barStock(barTypeId);
  }

  @Post('bar-stock/:barTypeId/move')
  @HttpCode(200)
  async moveBars(@Param('barTypeId', ParseIntPipe) barTypeId: number, @Body() dto: BarMoveDto) {
    const r = await this.actions.moveBars(barTypeId, dto);
    return { ...(await this.read.barStock(barTypeId)), warnings: r.warnings };
  }
}
