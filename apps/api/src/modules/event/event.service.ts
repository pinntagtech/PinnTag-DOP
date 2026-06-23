import { Injectable } from '@nestjs/common';
import { EventRepository } from './event.repository';
import { Event, EventDocument } from './event.schema';

@Injectable()
export class EventService {
  constructor(private readonly eventRepository: EventRepository) {}

  async create(data: Partial<Event>): Promise<EventDocument> {
    return this.eventRepository.create(data);
  }

  async findById(id: string): Promise<EventDocument | null> {
    return this.eventRepository.findById(id);
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<EventDocument | null> {
    return this.eventRepository.findOne(filter);
  }

  async findAll(filter: Record<string, any> = {}): Promise<EventDocument[]> {
    return this.eventRepository.findAll(filter);
  }

  async update(
    id: string,
    data: Partial<Event>,
  ): Promise<EventDocument | null> {
    return this.eventRepository.update(id, data);
  }

  async delete(id: string): Promise<EventDocument | null> {
    return this.eventRepository.delete(id);
  }
}
