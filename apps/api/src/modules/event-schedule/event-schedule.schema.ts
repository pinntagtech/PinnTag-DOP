import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class EventSchedule {
  @Prop({ type: Types.ObjectId, required: true, ref: 'Event' })
  event: Types.ObjectId;

  @Prop({ type: Date })
  date: Date;

  @Prop({ type: Date })
  startTime: Date;

  @Prop({ type: Date })
  endTime: Date;

  @Prop({ type: Boolean, default: false })
  isRecurring: boolean;

  @Prop({ type: String })
  recurrenceRule: string;
}

export type EventScheduleDocument = EventSchedule & Document;
export const EventScheduleSchema =
  SchemaFactory.createForClass(EventSchedule);
