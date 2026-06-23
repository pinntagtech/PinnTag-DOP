import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { EventScheduleService } from './event-schedule.service';
import { CreateEventScheduleDto } from './dto/create-event-schedule.dto';

@Controller('event-schedules')
export class EventScheduleController {
  constructor(
    private readonly eventScheduleService: EventScheduleService,
  ) {}

  @Post()
  async create(@Body() dto: CreateEventScheduleDto) {
    return this.eventScheduleService.create(dto as any);
  }

  @Get()
  async findAll() {
    return this.eventScheduleService.findAll();
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    return this.eventScheduleService.findById(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() data: Partial<CreateEventScheduleDto>,
  ) {
    return this.eventScheduleService.update(id, data as any);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.eventScheduleService.delete(id);
  }
}
