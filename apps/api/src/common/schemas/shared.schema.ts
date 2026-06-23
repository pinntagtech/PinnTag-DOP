import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

// ─── Hours ──────────────────────────────────────────────────────────────────────

@Schema({ _id: false })
export class Hours {
  @Prop({ type: Number })
  hour: number;

  @Prop({ type: Number })
  minute: number;
}
export const HoursSchema = SchemaFactory.createForClass(Hours);

// ─── TimeBracket ────────────────────────────────────────────────────────────────

@Schema({ _id: false })
export class TimeBracket {
  @Prop({ type: HoursSchema })
  startTime: Hours;

  @Prop({ type: HoursSchema })
  endTime: Hours;
}
export const TimeBracketSchema = SchemaFactory.createForClass(TimeBracket);

// ─── LocationType ───────────────────────────────────────────────────────────────

@Schema({ _id: false })
export class LocationType {
  @Prop({ type: String })
  type: string;

  @Prop({ type: [Number] })
  coordinates: number[];
}
export const LocationTypeSchema = SchemaFactory.createForClass(LocationType);

// ─── Duration (business schedule) ───────────────────────────────────────────────

@Schema({ _id: false })
export class Duration {
  @Prop({ type: Number })
  startHour: number;

  @Prop({ type: Number })
  startMinute: number;

  @Prop({ type: Number })
  endHour: number;

  @Prop({ type: Number })
  endMinute: number;
}
export const DurationSchema = SchemaFactory.createForClass(Duration);

// ─── DaySchedule ────────────────────────────────────────────────────────────────

@Schema({ _id: false })
export class DaySchedule {
  // Real PinnTag main-backend shape: null on closed days, populated on
  // open days. The legacy DOP code wrote a zero-duration object for
  // closed days; resolve writes now produce the schema-correct shape.
  @Prop({ type: DurationSchema, default: null })
  duration: Duration | null;

  @Prop({ type: Boolean, default: false })
  isClosed: boolean;
}
export const DayScheduleSchema = SchemaFactory.createForClass(DaySchedule);

// ─── Schedule (weekDays) ────────────────────────────────────────────────────────

@Schema({ _id: false })
export class Schedule {
  @Prop({
    type: {
      sunday: { type: DayScheduleSchema },
      monday: { type: DayScheduleSchema },
      tuesday: { type: DayScheduleSchema },
      wednesday: { type: DayScheduleSchema },
      thursday: { type: DayScheduleSchema },
      friday: { type: DayScheduleSchema },
      saturday: { type: DayScheduleSchema },
    },
  })
  weekDays: {
    sunday: DaySchedule;
    monday: DaySchedule;
    tuesday: DaySchedule;
    wednesday: DaySchedule;
    thursday: DaySchedule;
    friday: DaySchedule;
    saturday: DaySchedule;
  };
}
export const ScheduleSchema = SchemaFactory.createForClass(Schedule);
