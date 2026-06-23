import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { EventService } from './event.service';
import { CreateEventDto } from './dto/create-event.dto';

@Controller('events')
export class EventController {
  constructor(private readonly eventService: EventService) {}

  @Post()
  async create(@Body() dto: CreateEventDto) {
    return this.eventService.create(dto);
  }

  @Get()
  async findAll() {
    return this.eventService.findAll();
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    return this.eventService.findById(id);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() data: Partial<CreateEventDto>) {
    return this.eventService.update(id, data);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.eventService.delete(id);
  }
}
