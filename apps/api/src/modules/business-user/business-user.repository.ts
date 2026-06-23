import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, UpdateQuery } from 'mongoose';
import { BusinessUser, BusinessUserDocument } from './business-user.schema';

@Injectable()
export class BusinessUserRepository {
  constructor(
    @InjectModel(BusinessUser.name)
    private readonly businessUserModel: Model<BusinessUserDocument>,
  ) {}

  async create(data: Partial<BusinessUser>): Promise<BusinessUserDocument> {
    return this.businessUserModel.create(data);
  }

  async findById(id: string): Promise<BusinessUserDocument | null> {
    return this.businessUserModel.findById(id).exec();
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<BusinessUserDocument | null> {
    return this.businessUserModel.findOne(filter).exec();
  }

  async findAll(
    filter: Record<string, any> = {},
  ): Promise<BusinessUserDocument[]> {
    return this.businessUserModel.find(filter).exec();
  }

  async update(
    id: string,
    data: UpdateQuery<BusinessUser>,
  ): Promise<BusinessUserDocument | null> {
    return this.businessUserModel
      .findByIdAndUpdate(id, data, { returnDocument: 'after' })
      .exec();
  }

  async delete(id: string): Promise<BusinessUserDocument | null> {
    return this.businessUserModel
      .findByIdAndUpdate(id, { isDeleted: true }, { returnDocument: 'after' })
      .exec();
  }
}
