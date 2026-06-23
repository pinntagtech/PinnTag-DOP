import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, UpdateQuery } from 'mongoose';
import { Menu, MenuDocument } from './menu.schema';

@Injectable()
export class MenuRepository {
  constructor(
    @InjectModel(Menu.name)
    private readonly menuModel: Model<MenuDocument>,
  ) {}

  async create(data: Partial<Menu>): Promise<MenuDocument> {
    return this.menuModel.create(data);
  }

  async findById(id: string): Promise<MenuDocument | null> {
    return this.menuModel.findById(id).exec();
  }

  async findOne(
    filter: Record<string, any>,
  ): Promise<MenuDocument | null> {
    return this.menuModel.findOne(filter).exec();
  }

  async findAll(filter: Record<string, any> = {}): Promise<MenuDocument[]> {
    return this.menuModel.find(filter).exec();
  }

  async update(
    id: string,
    data: UpdateQuery<Menu>,
  ): Promise<MenuDocument | null> {
    return this.menuModel
      .findByIdAndUpdate(id, data, { returnDocument: 'after' })
      .exec();
  }

  async delete(id: string): Promise<MenuDocument | null> {
    return this.menuModel.findByIdAndDelete(id).exec();
  }
}
