import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SeedingLocation,
  SeedingLocationDocument,
  LocationArea,
} from './schemas/seeding-location.schema';

@Injectable()
export class LocationsRepository {
  constructor(
    @InjectModel(SeedingLocation.name)
    private readonly model: Model<SeedingLocationDocument>,
  ) {}

  async create(
    data: Partial<SeedingLocation>,
  ): Promise<SeedingLocationDocument> {
    return this.model.create(data);
  }

  async findAll(): Promise<SeedingLocationDocument[]> {
    return this.model.find().sort({ city: 1 }).exec();
  }

  async findActive(): Promise<SeedingLocationDocument[]> {
    return this.model.find({ isActive: true }).sort({ city: 1 }).exec();
  }

  async findById(id: string): Promise<SeedingLocationDocument | null> {
    return this.model.findById(id).exec();
  }

  async findByCityKey(
    cityKey: string,
  ): Promise<SeedingLocationDocument | null> {
    return this.model.findOne({ cityKey }).exec();
  }

  async update(
    id: string,
    data: Partial<SeedingLocation>,
  ): Promise<SeedingLocationDocument | null> {
    return this.model
      .findByIdAndUpdate(id, data, { returnDocument: 'after' })
      .exec();
  }

  async delete(id: string): Promise<SeedingLocationDocument | null> {
    return this.model.findByIdAndDelete(id).exec();
  }

  async pushArea(
    id: string,
    area: LocationArea,
  ): Promise<SeedingLocationDocument | null> {
    return this.model
      .findByIdAndUpdate(
        id,
        { $push: { areas: area } },
        { returnDocument: 'after' },
      )
      .exec();
  }

  async updateArea(
    id: string,
    areaName: string,
    patch: Partial<LocationArea>,
  ): Promise<SeedingLocationDocument | null> {
    const setOps: Record<string, any> = {};
    for (const [k, v] of Object.entries(patch)) {
      setOps[`areas.$.${k}`] = v;
    }
    return this.model
      .findOneAndUpdate(
        { _id: id, 'areas.name': areaName },
        { $set: setOps },
        { returnDocument: 'after' },
      )
      .exec();
  }

  async removeArea(
    id: string,
    areaName: string,
  ): Promise<SeedingLocationDocument | null> {
    return this.model
      .findByIdAndUpdate(
        id,
        { $pull: { areas: { name: areaName } } },
        { returnDocument: 'after' },
      )
      .exec();
  }

  async count(): Promise<number> {
    return this.model.estimatedDocumentCount().exec();
  }
}
