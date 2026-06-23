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
import { AddressParseService } from './address-parse.service';
import { AddressApplyService } from './address-apply.service';

@Controller('seeding/address-parse')
export class AddressParseController {
  constructor(
    private readonly addressParseService: AddressParseService,
    private readonly addressApplyService: AddressApplyService,
  ) {}

  // Count of businesses awaiting parse (raw captured, addressStatus
  // still 'address_unparsed'). Drives the portal banner.
  @UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Get('pending')
  async pending(@Query('environment') environment: string) {
    if (!environment) {
      throw new HttpException('environment query param is required', 400);
    }
    return this.addressParseService.countPending(environment);
  }

  // Batch parser run: pulls up to `limit` rows (default 50, max 200),
  // POSTs each to apps/address-parser, writes addressStatus +
  // proposedAddress back. dryRun reports counts without writes.
  @UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Post('run')
  async run(
    @Body()
    body: { environment: string; limit?: number; dryRun?: boolean },
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    return this.addressParseService.runBatch({
      environment: body.environment,
      limit: body.limit,
      dryRun: body.dryRun === true,
    });
  }

  // Operator's "Fix address" tab list — addressStatus='address_mismatch'
  // rows with proposedAddress, current address fields, and the raw
  // googleFormattedAddress for side-by-side review.
  @UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Get('mismatch')
  async listMismatch(
    @Query('environment') environment: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!environment) {
      throw new HttpException('environment query param is required', 400);
    }
    return this.addressApplyService.listMismatch({
      environment,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 25,
    });
  }

  // Apply: writes proposedAddress.address1 onto the consumer's
  // `addressLine1` display field, plus city/state/postalCode/country/
  // countryCode, and $unsets the legacy `address1` parser-artifact
  // for each selected business. Does NOT touch the business's
  // outlets — they're distinct physical locations and get their own
  // resolve/parse/apply pass via the outlet-corruption pipeline
  // (see /data-repair/outlet-address-corrupt). dryRun returns the
  // would-be business writes (addressLine1 before/after) without
  // touching the doc.
  @UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Post('apply')
  async apply(
    @Body()
    body: {
      environment: string;
      businessIds: string[];
      dryRun?: boolean;
    },
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    if (!Array.isArray(body.businessIds)) {
      throw new HttpException('businessIds[] is required', 400);
    }
    return this.addressApplyService.applyBatch({
      environment: body.environment,
      businessIds: body.businessIds,
      dryRun: body.dryRun === true,
    });
  }

  // (Removed) /backfill-outlets — copied the parent business's
  // address down to every linked outlet. Wrong assumption: outlets
  // are independent physical locations, not parent copies. Outlet
  // address corruption is detected + fixed via its own pipeline
  // (see /data-repair/outlet-address-corrupt).
}
