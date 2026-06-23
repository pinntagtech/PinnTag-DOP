import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { LocationsRepository } from './locations.repository';
import {
  SeedingLocation,
  SeedingLocationDocument,
  LocationArea,
} from './schemas/seeding-location.schema';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { AreaDto } from './dto/area.dto';
import { SEED_LOCATIONS } from './locations.seed';

@Injectable()
export class LocationsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LocationsService.name);

  constructor(private readonly repo: LocationsRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedIfEmpty();
  }

  async seedIfEmpty(): Promise<void> {
    const count = await this.repo.count();
    if (count > 0) {
      this.logger.log(
        `[LOCATIONS] Seed skipped — ${count} cities already present`,
      );
      return;
    }

    let inserted = 0;
    for (const seed of SEED_LOCATIONS) {
      try {
        await this.repo.create({
          city: seed.city,
          cityKey: seed.city.toLowerCase(),
          state: seed.state,
          areas: seed.areas as LocationArea[],
          isActive: true,
        });
        inserted++;
      } catch (err: any) {
        this.logger.warn(
          `[LOCATIONS] Seed failed for ${seed.city}: ${err.message}`,
        );
      }
    }

    this.logger.log(`[LOCATIONS] Seeded ${inserted} cities`);
  }

  async list(): Promise<SeedingLocationDocument[]> {
    return this.repo.findAll();
  }

  async listActive(): Promise<SeedingLocationDocument[]> {
    return this.repo.findActive();
  }

  async get(id: string): Promise<SeedingLocationDocument> {
    const doc = await this.repo.findById(id);
    if (!doc) throw new NotFoundException(`Location ${id} not found`);
    return doc;
  }

  async create(
    dto: CreateLocationDto,
    createdBy?: string,
  ): Promise<SeedingLocationDocument> {
    if (!dto.city?.trim()) {
      throw new BadRequestException('city is required');
    }
    if (!dto.state?.trim()) {
      throw new BadRequestException('state is required');
    }
    const cityKey = dto.city.trim().toLowerCase();
    const existing = await this.repo.findByCityKey(cityKey);
    if (existing) {
      throw new ConflictException(`City already exists: ${dto.city}`);
    }
    return this.repo.create({
      city: dto.city.trim(),
      cityKey,
      state: dto.state.trim().toUpperCase(),
      areas: (dto.areas ?? []) as LocationArea[],
      isActive: dto.isActive ?? true,
      ...(createdBy ? { createdBy: createdBy as any } : {}),
    });
  }

  async update(
    id: string,
    dto: UpdateLocationDto,
  ): Promise<SeedingLocationDocument> {
    await this.get(id);
    const patch: Partial<SeedingLocation> = {};
    if (dto.city !== undefined) {
      patch.city = dto.city.trim();
      patch.cityKey = dto.city.trim().toLowerCase();
    }
    if (dto.state !== undefined) {
      patch.state = dto.state.trim().toUpperCase();
    }
    if (dto.isActive !== undefined) {
      patch.isActive = dto.isActive;
    }
    const updated = await this.repo.update(id, patch);
    if (!updated) throw new NotFoundException(`Location ${id} not found`);
    return updated;
  }

  async remove(id: string): Promise<void> {
    const removed = await this.repo.delete(id);
    if (!removed) throw new NotFoundException(`Location ${id} not found`);
  }

  async addArea(
    id: string,
    area: AreaDto,
  ): Promise<SeedingLocationDocument> {
    if (!area.name?.trim()) {
      throw new BadRequestException('area.name is required');
    }
    const doc = await this.get(id);
    if (doc.areas.some((a) => a.name.toLowerCase() === area.name.toLowerCase())) {
      throw new ConflictException(`Area already exists: ${area.name}`);
    }
    const updated = await this.repo.pushArea(id, {
      name: area.name.trim(),
      ...(area.subRegion ? { subRegion: area.subRegion.trim() } : {}),
      ...(area.state ? { state: area.state.trim().toUpperCase() } : {}),
    } as LocationArea);
    if (!updated) throw new NotFoundException(`Location ${id} not found`);
    return updated;
  }

  async updateArea(
    id: string,
    areaName: string,
    patch: Partial<AreaDto>,
  ): Promise<SeedingLocationDocument> {
    const normalized: Partial<LocationArea> = {};
    if (patch.name !== undefined) normalized.name = patch.name.trim();
    if (patch.subRegion !== undefined) {
      normalized.subRegion = patch.subRegion.trim();
    }
    if (patch.state !== undefined) {
      normalized.state = patch.state.trim().toUpperCase();
    }
    const updated = await this.repo.updateArea(id, areaName, normalized);
    if (!updated) {
      throw new NotFoundException(`Area "${areaName}" not found in ${id}`);
    }
    return updated;
  }

  async removeArea(
    id: string,
    areaName: string,
  ): Promise<SeedingLocationDocument> {
    const updated = await this.repo.removeArea(id, areaName);
    if (!updated) throw new NotFoundException(`Location ${id} not found`);
    return updated;
  }
}
