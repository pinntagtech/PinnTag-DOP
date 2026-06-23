import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  EventLocation,
  EventLocationSchema,
} from './event-location.schema';
import { EventLocationRepository } from './event-location.repository';
import { EventLocationService } from './event-location.service';
import { EventLocationController } from './event-location.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EventLocation.name, schema: EventLocationSchema },
    ]),
  ],
  controllers: [EventLocationController],
  providers: [EventLocationRepository, EventLocationService],
  exports: [EventLocationService],
})
export class EventLocationModule {}
