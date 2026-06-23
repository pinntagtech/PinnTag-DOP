import { Injectable } from '@nestjs/common';
import { EventScheduleRepository } from './event-schedule.repository';
import {
  EventSchedule,
  EventScheduleDocument,
} from './event-schedule.schema';

@Injectable()
export class EventScheduleService {
  constructor(
    private readonly eventScheduleRepository: EventScheduleRepository,
  ) {}

  async create(
    data: Partial<EventSchedule>,
  ): Promise<EventScheduleDocument> {
    return this.eventScheduleRepository.create(data);
  }

  async findById(id: string): Promise<EventScheduleDocument | null> {
    return this.eventScheduleRepository.findById(id);
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<EventScheduleDocument | null> {
    return this.eventScheduleRepository.findOne(filter);
  }

  async findAll(
    filter: Record<string, any> = {},
  ): Promise<EventScheduleDocument[]> {
    return this.eventScheduleRepository.findAll(filter);
  }

  async update(
    id: string,
    data: Partial<EventSchedule>,
  ): Promise<EventScheduleDocument | null> {
    return this.eventScheduleRepository.update(id, data);
  }

  async delete(id: string): Promise<EventScheduleDocument | null> {
    return this.eventScheduleRepository.delete(id);
  }
}
