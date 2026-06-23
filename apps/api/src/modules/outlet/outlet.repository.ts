import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, UpdateQuery } from 'mongoose';
import { Outlet, OutletDocument } from './outlet.schema';

@Injectable()
export class OutletRepository {
  constructor(
    @InjectModel(Outlet.name)
    private readonly outletModel: Model<OutletDocument>,
  ) {}

  async create(data: Partial<Outlet>): Promise<OutletDocument> {
    return this.outletModel.create(data);
  }

  async findById(id: string): Promise<OutletDocument | null> {
    return this.outletModel.findById(id).exec();
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<OutletDocument | null> {
    return this.outletModel.findOne(filter).exec();
  }

  async findAll(
    filter: Record<string, any> = {},
  ): Promise<OutletDocument[]> {
    return this.outletModel.find(filter).exec();
  }

  async update(
    id: string,
    data: UpdateQuery<Outlet>,
  ): Promise<OutletDocument | null> {
    return this.outletModel
      .findByIdAndUpdate(id, data, { returnDocument: 'after' })
      .exec();
  }

  async delete(id: string): Promise<OutletDocument | null> {
    return this.outletModel
      .findByIdAndUpdate(id, { isDeleted: true }, { returnDocument: 'after' })
      .exec();
  }
}
