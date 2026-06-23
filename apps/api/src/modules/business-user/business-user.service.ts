import { Injectable } from '@nestjs/common';
import { BusinessUserRepository } from './business-user.repository';
import { BusinessUser, BusinessUserDocument } from './business-user.schema';

@Injectable()
export class BusinessUserService {
  constructor(
    private readonly businessUserRepository: BusinessUserRepository,
  ) {}

  async create(data: Partial<BusinessUser>): Promise<BusinessUserDocument> {
    return this.businessUserRepository.create(data);
  }

  async findById(id: string): Promise<BusinessUserDocument | null> {
    return this.businessUserRepository.findById(id);
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<BusinessUserDocument | null> {
    return this.businessUserRepository.findOne(filter);
  }

  async findAll(
    filter: Record<string, any> = {},
  ): Promise<BusinessUserDocument[]> {
    return this.businessUserRepository.findAll(filter);
  }

  async update(
    id: string,
    data: Partial<BusinessUser>,
  ): Promise<BusinessUserDocument | null> {
    return this.businessUserRepository.update(id, data);
  }

  async delete(id: string): Promise<BusinessUserDocument | null> {
    return this.businessUserRepository.delete(id);
  }
}
