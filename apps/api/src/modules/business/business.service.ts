import { Injectable } from '@nestjs/common';
import { BusinessRepository } from './business.repository';
import { Business, BusinessDocument } from './business.schema';

@Injectable()
export class BusinessService {
  constructor(private readonly businessRepository: BusinessRepository) {}

  async create(data: Partial<Business>): Promise<BusinessDocument> {
    return this.businessRepository.create(data);
  }

  async findById(id: string): Promise<BusinessDocument | null> {
    return this.businessRepository.findById(id);
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<BusinessDocument | null> {
    return this.businessRepository.findOne(filter);
  }

  async findAll(
    filter: Record<string, any> = {},
  ): Promise<BusinessDocument[]> {
    return this.businessRepository.findAll(filter);
  }

  async update(
    id: string,
    data: Partial<Business>,
  ): Promise<BusinessDocument | null> {
    return this.businessRepository.update(id, data);
  }

  async delete(id: string): Promise<BusinessDocument | null> {
    return this.businessRepository.delete(id);
  }
}
