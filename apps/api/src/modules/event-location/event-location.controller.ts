import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { EventLocationService } from './event-location.service';
import { CreateEventLocationDto } from './dto/create-event-location.dto';

@Controller('event-locations')
export class EventLocationController {
  constructor(
    private readonly eventLocationService: EventLocationService,
  ) {}

  @Post()
  async create(@Body() dto: CreateEventLocationDto) {
    return this.eventLocationService.create(dto as any);
  }

  @Get()
  async findAll() {
    return this.eventLocationService.findAll();
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    return this.eventLocationService.findById(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() data: Partial<CreateEventLocationDto>,
  ) {
    return this.eventLocationService.update(id, data as any);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.eventLocationService.delete(id);
  }
}
