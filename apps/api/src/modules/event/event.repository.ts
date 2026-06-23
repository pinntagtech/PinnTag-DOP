import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, UpdateQuery } from 'mongoose';
import { Event, EventDocument } from './event.schema';

@Injectable()
export class EventRepository {
  constructor(
    @InjectModel(Event.name)
    private readonly eventModel: Model<EventDocument>,
  ) {}

  async create(data: Partial<Event>): Promise<EventDocument> {
    return this.eventModel.create(data);
  }

  async findById(id: string): Promise<EventDocument | null> {
    return this.eventModel.findById(id).exec();
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<EventDocument | null> {
    return this.eventModel.findOne(filter).exec();
  }

  async findAll(
    filter: Record<string, any> = {},
  ): Promise<EventDocument[]> {
    return this.eventModel.find(filter).exec();
  }

  async update(
    id: string,
    data: UpdateQuery<Event>,
  ): Promise<EventDocument | null> {
    return this.eventModel
      .findByIdAndUpdate(id, data, { returnDocument: 'after' })
      .exec();
  }

  async delete(id: string): Promise<EventDocument | null> {
    return this.eventModel.findByIdAndDelete(id).exec();
  }
}
