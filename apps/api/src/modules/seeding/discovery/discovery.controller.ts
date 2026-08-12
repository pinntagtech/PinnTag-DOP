import { Controller, HttpException, Logger, Param, Post } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';

@Controller('seeding/discovery')
export class DiscoveryController {
  private readonly logger = new Logger(DiscoveryController.name);

  constructor(private readonly discovery: DiscoveryService) {}

  // Idempotent upsert of the shipped region set. Safe to call repeatedly;
  // only fills gaps and refreshes bbox/priority. Never resets runtime
  // status/stats. Not gated behind admin password — the region set is
  // hardcoded in region-seed-data.ts, this endpoint only projects it.
  @Post('regions/seed')
  async seedRegions() {
    return this.discovery.seedRegions();
  }

  // Phase 1 dry-run preview. No writes to staging. Mirrors the shape of
  // /seeding/migration/gated/preview so operators have one mental model.
  @Post('regions/:regionId/preview')
  async preview(@Param('regionId') regionId: string) {
    try {
      return await this.discovery.previewRegion(regionId);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = (e as Error).message ?? String(e);
      this.logger.error(`preview ${regionId} failed: ${msg}`);
      throw new HttpException(msg, 500);
    }
  }
}
