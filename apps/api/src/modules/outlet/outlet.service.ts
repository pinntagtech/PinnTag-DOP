import { Injectable } from '@nestjs/common';
import { OutletRepository } from './outlet.repository';
import { Outlet, OutletDocument } from './outlet.schema';

@Injectable()
export class OutletService {
  constructor(private readonly outletRepository: OutletRepository) {}

  async create(data: Partial<Outlet>): Promise<OutletDocument> {
    return this.outletRepository.create(data);
  }

  async findById(id: string): Promise<OutletDocument | null> {
    return this.outletRepository.findById(id);
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<OutletDocument | null> {
    return this.outletRepository.findOne(filter);
  }

  async findAll(filter: Record<string, any> = {}): Promise<OutletDocument[]> {
    return this.outletRepository.findAll(filter);
  }

  async update(
    id: string,
    data: Partial<Outlet>,
  ): Promise<OutletDocument | null> {
    return this.outletRepository.update(id, data);
  }

  async delete(id: string): Promise<OutletDocument | null> {
    return this.outletRepository.delete(id);
  }
}
