import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { LocationsService } from './locations.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { AreaDto } from './dto/area.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { DopUserRole } from '../auth/schemas/dop-user.schema';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(DopUserRole.SUPER_ADMIN)
@Controller('locations')
export class LocationsController {
  constructor(private readonly service: LocationsService) {}

  @Get()
  async list() {
    return this.service.list();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  async create(@Body() dto: CreateLocationDto, @Request() req: any) {
    const createdBy = req.user?._id?.toString();
    return this.service.create(dto, createdBy);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.service.remove(id);
    return { message: 'Location deleted' };
  }

  @Post(':id/areas')
  async addArea(@Param('id') id: string, @Body() area: AreaDto) {
    return this.service.addArea(id, area);
  }

  // areaName lives in the body — slash and ampersand are common in
  // canonical names ("Galleria/Uptown", "Power & Light District") and
  // would otherwise break Express path matching for unencoded callers.
  @Patch(':id/areas')
  async updateArea(
    @Param('id') id: string,
    @Body() body: { areaName: string; patch: Partial<AreaDto> },
  ) {
    return this.service.updateArea(id, body.areaName, body.patch ?? {});
  }

  // DELETE-with-body is awkward across some HTTP clients; use POST.
  @Post(':id/areas/remove')
  async removeArea(
    @Param('id') id: string,
    @Body() body: { areaName: string },
  ) {
    return this.service.removeArea(id, body.areaName);
  }
}
