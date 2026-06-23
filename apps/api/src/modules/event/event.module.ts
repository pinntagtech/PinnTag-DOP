import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Event, EventSchema } from './event.schema';
import { EventRepository } from './event.repository';
import { EventService } from './event.service';
import { EventController } from './event.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Event.name, schema: EventSchema },
    ]),
  ],
  controllers: [EventController],
  providers: [EventRepository, EventService],
  exports: [EventService],
})
export class EventModule {}
