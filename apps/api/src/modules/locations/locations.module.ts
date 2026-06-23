import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  SeedingLocation,
  SeedingLocationSchema,
} from './schemas/seeding-location.schema';
import { LocationsRepository } from './locations.repository';
import { LocationsService } from './locations.service';
import { LocationsController } from './locations.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SeedingLocation.name, schema: SeedingLocationSchema },
    ]),
    AuthModule,
  ],
  controllers: [LocationsController],
  providers: [LocationsRepository, LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
