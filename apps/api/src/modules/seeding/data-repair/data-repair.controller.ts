import {
  Body,
  Controller,
  Get,
  HttpException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { EnvGuard } from '../../auth/guards/env.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DopUserRole } from '../../auth/schemas/dop-user.schema';
import {
  AddressCorruptSignature,
  DataRepairService,
} from './data-repair.service';

// Closed-set guard for the ?signature= filter — anything else is
// folded back to 'all' so a stale portal build can't 400 the
// endpoint.
const ADDRESS_CORRUPT_SIG_VALUES: readonly AddressCorruptSignature[] = [
  'us_state_non_us_coords',
  'digits_only_city',
  'plus1_non_us_coords',
  'missing_country_with_addr',
];

@UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
@Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
@Controller('data-repair')
export class DataRepairController {
  constructor(private readonly dataRepairService: DataRepairService) {}

  // ── FIX 1 — regularTiming ──────────────────────────────────────────────

  @Get('regular-timing')
  async listBadRegularTiming(
    @Query('environment') environment: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!environment) {
      throw new HttpException('environment query param is required', 400);
    }
    return this.dataRepairService.listBadRegularTiming(
      environment,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 25,
    );
  }

  @Post('regular-timing')
  async fixRegularTiming(
    @Body()
    body: {
      environment: string;
      businessIds?: string[];
      applyAll?: boolean;
      dryRun: boolean;
    },
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    return this.dataRepairService.fixRegularTiming({
      environment: body.environment,
      businessIds: body.businessIds,
      applyAll: body.applyAll,
      dryRun: body.dryRun !== false, // default dry unless explicitly false
    });
  }

  // ── FIX 2 — missing outlet ─────────────────────────────────────────────

  @Get('missing-outlet')
  async listMissingOutlet(
    @Query('environment') environment: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!environment) {
      throw new HttpException('environment query param is required', 400);
    }
    return this.dataRepairService.listMissingOutlet(
      environment,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 25,
    );
  }

  @Post('missing-outlet')
  async fixMissingOutlet(
    @Body()
    body: {
      environment: string;
      businessIds: string[];
      dryRun: boolean;
    },
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    if (!Array.isArray(body.businessIds)) {
      throw new HttpException('businessIds[] is required', 400);
    }
    return this.dataRepairService.fixMissingOutlet({
      environment: body.environment,
      businessIds: body.businessIds,
      dryRun: body.dryRun !== false,
    });
  }

  // ── FIX 3 — inactive activation ────────────────────────────────────────

  @Get('inactive')
  async listInactive(
    @Query('environment') environment: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('city') city?: string,
    @Query('state') state?: string,
    @Query('search') search?: string,
    @Query('hideIncomplete') hideIncomplete?: string,
  ) {
    if (!environment) {
      throw new HttpException('environment query param is required', 400);
    }
    return this.dataRepairService.listInactive({
      environment,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 25,
      city,
      state,
      search,
      hideIncomplete: hideIncomplete === 'true' || hideIncomplete === '1',
    });
  }

  @Post('inactive')
  async activateInactive(
    @Body()
    body: {
      environment: string;
      businessIds: string[];
      dryRun: boolean;
    },
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    if (!Array.isArray(body.businessIds)) {
      throw new HttpException('businessIds[] is required', 400);
    }
    // Hard ceiling: a single activate batch can address at most 1000
    // businesses. Matches the portal's select-all cap and the
    // listInactive page-size cap. The service still iterates in
    // DATA_REPAIR_BATCH_SIZE (50) internal chunks, so a 1000-id batch
    // is ~20 DB rounds — comfortably inside a normal request timeout.
    if (body.businessIds.length > 1000) {
      throw new HttpException(
        'businessIds[] exceeds the 1000-per-batch limit',
        400,
      );
    }
    return this.dataRepairService.activateInactive({
      environment: body.environment,
      businessIds: body.businessIds,
      // Default to dry-run unless the body explicitly says false —
      // mirrors the other repair endpoints and keeps a slip-up from
      // doing a live flip.
      dryRun: body.dryRun !== false,
    });
  }

  // ── FIX 4 — taxonomy correction (flag-only resolve → operator apply) ──

  @Get('taxonomy')
  async listTaxonomy(
    @Query('environment') environment: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('statusFilter') statusFilter?: string,
    @Query('city') city?: string,
    @Query('state') state?: string,
    @Query('search') search?: string,
  ) {
    if (!environment) {
      throw new HttpException('environment query param is required', 400);
    }
    const allowed = new Set(['mismatch', 'unmapped', 'all']);
    const sf = statusFilter && allowed.has(statusFilter)
      ? (statusFilter as 'mismatch' | 'unmapped' | 'all')
      : 'mismatch';
    return this.dataRepairService.listTaxonomy({
      environment,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 25,
      statusFilter: sf,
      city,
      state,
      search,
    });
  }

  @Post('taxonomy')
  async applyTaxonomy(
    @Body()
    body: {
      environment: string;
      businessIds: string[];
      dryRun: boolean;
    },
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    if (!Array.isArray(body.businessIds)) {
      throw new HttpException('businessIds[] is required', 400);
    }
    return this.dataRepairService.applyTaxonomy({
      environment: body.environment,
      businessIds: body.businessIds,
      dryRun: body.dryRun !== false,
    });
  }

  // ── FIX 5 — corrupt-address detector ──────────────────────────────────
  //
  // Find businesses whose live address fields trigger one of the four
  // Stage B corruption signatures. Independent of the parser pipeline:
  // the operator can use this scan to spot corruption BEFORE any
  // googleFormattedAddress capture, then re-resolve the matched set so
  // the parser can act on them. No apply endpoint here — corrupt rows
  // flow into the resolve queue (which already has its own controller)
  // and then through the address-parse → mismatch → apply pipeline.

  @Get('address-corrupt')
  async listAddressCorrupt(
    @Query('environment') environment: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('signature') signature?: string,
    @Query('city') city?: string,
    @Query('state') state?: string,
  ) {
    if (!environment) {
      throw new HttpException('environment query param is required', 400);
    }
    const sig =
      signature &&
      (ADDRESS_CORRUPT_SIG_VALUES as readonly string[]).includes(signature)
        ? (signature as AddressCorruptSignature)
        : 'all';
    return this.dataRepairService.listAddressCorrupt({
      environment,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 25,
      signature: sig,
      city,
      state,
    });
  }

  // Outlet-side equivalent of /address-corrupt. Same four signatures
  // applied to each outlet's OWN address / coords / phone — an outlet
  // is corrupt iff its own fields contradict each other, independent
  // of the parent business. Fix flow is per-outlet resolve → parse →
  // apply on the outlet's own fields (NOT a parent copy: outlets are
  // distinct physical locations from their parent).
  @Get('outlet-address-corrupt')
  async listAddressCorruptOutlets(
    @Query('environment') environment: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('signature') signature?: string,
    @Query('city') city?: string,
    @Query('state') state?: string,
  ) {
    if (!environment) {
      throw new HttpException('environment query param is required', 400);
    }
    const sig =
      signature &&
      (ADDRESS_CORRUPT_SIG_VALUES as readonly string[]).includes(signature)
        ? (signature as AddressCorruptSignature)
        : 'all';
    return this.dataRepairService.listAddressCorruptOutlets({
      environment,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 25,
      signature: sig,
      city,
      state,
    });
  }
}
