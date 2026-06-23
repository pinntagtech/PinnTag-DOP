import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, UpdateQuery } from 'mongoose';
import {
  EventLocation,
  EventLocationDocument,
} from './event-location.schema';

@Injectable()
export class EventLocationRepository {
  constructor(
    @InjectModel(EventLocation.name)
    private readonly eventLocationModel: Model<EventLocationDocument>,
  ) {}

  async create(
    data: Partial<EventLocation>,
  ): Promise<EventLocationDocument> {
    return this.eventLocationModel.create(data);
  }

  async findById(id: string): Promise<EventLocationDocument | null> {
    return this.eventLocationModel.findById(id).exec();
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<EventLocationDocument | null> {
    return this.eventLocationModel.findOne(filter).exec();
  }

  async findAll(
    filter: Record<string, any> = {},
  ): Promise<EventLocationDocument[]> {
    return this.eventLocationModel.find(filter).exec();
  }

  async update(
    id: string,
    data: UpdateQuery<EventLocation>,
  ): Promise<EventLocationDocument | null> {
    return this.eventLocationModel
      .findByIdAndUpdate(id, data, { returnDocument: 'after' })
      .exec();
  }

  async delete(id: string): Promise<EventLocationDocument | null> {
    return this.eventLocationModel.findByIdAndDelete(id).exec();
  }
}
