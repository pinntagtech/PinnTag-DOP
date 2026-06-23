import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  EventSchedule,
  EventScheduleSchema,
} from './event-schedule.schema';
import { EventScheduleRepository } from './event-schedule.repository';
import { EventScheduleService } from './event-schedule.service';
import { EventScheduleController } from './event-schedule.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EventSchedule.name, schema: EventScheduleSchema },
    ]),
  ],
  controllers: [EventScheduleController],
  providers: [EventScheduleRepository, EventScheduleService],
  exports: [EventScheduleService],
})
export class EventScheduleModule {}
