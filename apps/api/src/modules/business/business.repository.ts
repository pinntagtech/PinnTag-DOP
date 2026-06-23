import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, UpdateQuery } from 'mongoose';
import { Business, BusinessDocument } from './business.schema';

@Injectable()
export class BusinessRepository {
  constructor(
    @InjectModel(Business.name)
    private readonly businessModel: Model<BusinessDocument>,
  ) {}

  async create(data: Partial<Business>): Promise<BusinessDocument> {
    return this.businessModel.create(data);
  }

  async findById(id: string): Promise<BusinessDocument | null> {
    return this.businessModel.findById(id).exec();
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<BusinessDocument | null> {
    return this.businessModel.findOne(filter).exec();
  }

  async findAll(
    filter: Record<string, any> = {},
  ): Promise<BusinessDocument[]> {
    return this.businessModel.find(filter).exec();
  }

  async update(
    id: string,
    data: UpdateQuery<Business>,
  ): Promise<BusinessDocument | null> {
    return this.businessModel
      .findByIdAndUpdate(id, data, { returnDocument: 'after' })
      .exec();
  }

  async delete(id: string): Promise<BusinessDocument | null> {
    return this.businessModel
      .findByIdAndUpdate(id, { isDeleted: true }, { returnDocument: 'after' })
      .exec();
  }
}
