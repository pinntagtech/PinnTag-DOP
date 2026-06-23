import { Injectable } from '@nestjs/common';
import { EventLocationRepository } from './event-location.repository';
import {
  EventLocation,
  EventLocationDocument,
} from './event-location.schema';

@Injectable()
export class EventLocationService {
  constructor(
    private readonly eventLocationRepository: EventLocationRepository,
  ) {}

  async create(
    data: Partial<EventLocation>,
  ): Promise<EventLocationDocument> {
    return this.eventLocationRepository.create(data);
  }

  async findById(id: string): Promise<EventLocationDocument | null> {
    return this.eventLocationRepository.findById(id);
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<EventLocationDocument | null> {
    return this.eventLocationRepository.findOne(filter);
  }

  async findAll(
    filter: Record<string, any> = {},
  ): Promise<EventLocationDocument[]> {
    return this.eventLocationRepository.findAll(filter);
  }

  async update(
    id: string,
    data: Partial<EventLocation>,
  ): Promise<EventLocationDocument | null> {
    return this.eventLocationRepository.update(id, data);
  }

  async delete(id: string): Promise<EventLocationDocument | null> {
    return this.eventLocationRepository.delete(id);
  }
}
