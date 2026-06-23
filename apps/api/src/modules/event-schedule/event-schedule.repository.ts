import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, UpdateQuery } from 'mongoose';
import {
  EventSchedule,
  EventScheduleDocument,
} from './event-schedule.schema';

@Injectable()
export class EventScheduleRepository {
  constructor(
    @InjectModel(EventSchedule.name)
    private readonly eventScheduleModel: Model<EventScheduleDocument>,
  ) {}

  async create(
    data: Partial<EventSchedule>,
  ): Promise<EventScheduleDocument> {
    return this.eventScheduleModel.create(data);
  }

  async findById(id: string): Promise<EventScheduleDocument | null> {
    return this.eventScheduleModel.findById(id).exec();
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<EventScheduleDocument | null> {
    return this.eventScheduleModel.findOne(filter).exec();
  }

  async findAll(
    filter: Record<string, any> = {},
  ): Promise<EventScheduleDocument[]> {
    return this.eventScheduleModel.find(filter).exec();
  }

  async update(
    id: string,
    data: UpdateQuery<EventSchedule>,
  ): Promise<EventScheduleDocument | null> {
    return this.eventScheduleModel
      .findByIdAndUpdate(id, data, { returnDocument: 'after' })
      .exec();
  }

  async delete(id: string): Promise<EventScheduleDocument | null> {
    return this.eventScheduleModel.findByIdAndDelete(id).exec();
  }
}
