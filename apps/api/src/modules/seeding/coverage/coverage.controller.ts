import {
  Controller,
  Get,
  Logger,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { CoverageService } from './coverage.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DopUserRole } from '../../auth/schemas/dop-user.schema';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('seeding/coverage')
export class CoverageController {
  private readonly logger = new Logger(CoverageController.name);

  constructor(private readonly coverageService: CoverageService) {}

  @Get()
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN, DopUserRole.OPERATOR)
  async getCoverage(@Request() req: any) {
    const actor = req.user?.name || req.user?.email || 'system';
    return this.coverageService.getOrCompute(actor);
  }

  @Post('refresh')
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  async refresh(@Request() req: any) {
    const actor = req.user?.name || req.user?.email || 'admin';
    this.logger.log(`[COVERAGE] Refresh requested by ${actor}`);
    return this.coverageService.computeSnapshot(actor);
  }
}
