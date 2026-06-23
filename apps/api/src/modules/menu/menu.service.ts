import { Injectable } from '@nestjs/common';
import { MenuRepository } from './menu.repository';
import { Menu, MenuDocument } from './menu.schema';

@Injectable()
export class MenuService {
  constructor(private readonly menuRepository: MenuRepository) {}

  async create(data: Partial<Menu>): Promise<MenuDocument> {
    return this.menuRepository.create(data);
  }

  async findById(id: string): Promise<MenuDocument | null> {
    return this.menuRepository.findById(id);
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<MenuDocument | null> {
    return this.menuRepository.findOne(filter);
  }

  async findAll(filter: Record<string, any> = {}): Promise<MenuDocument[]> {
    return this.menuRepository.findAll(filter);
  }

  async update(
    id: string,
    data: Partial<Menu>,
  ): Promise<MenuDocument | null> {
    return this.menuRepository.update(id, data);
  }

  async delete(id: string): Promise<MenuDocument | null> {
    return this.menuRepository.delete(id);
  }
}
