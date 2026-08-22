import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { LaunchEngagementService } from './launch-engagement.service';
import { EnrollDto } from './dto/enroll.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { EnvGuard } from '../auth/guards/env.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { DopUserRole } from '../auth/schemas/dop-user.schema';

@UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
@Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
@Controller('launch-engagement')
export class LaunchEngagementController {
  constructor(private readonly service: LaunchEngagementService) {}

  @Post('enroll')
  async enroll(@Body() dto: EnrollDto) {
    return this.service.enroll(dto.targetEnvironment, dto.businessId);
  }

  @Post('unenroll')
  async unenroll(@Body() dto: EnrollDto) {
    return this.service.unenroll(dto.targetEnvironment, dto.businessId);
  }

  @Get('status')
  async status(
    @Query('targetEnvironment') targetEnvironment: string,
    @Query('businessId') businessId: string,
  ) {
    return this.service.status(targetEnvironment, businessId);
  }
}
