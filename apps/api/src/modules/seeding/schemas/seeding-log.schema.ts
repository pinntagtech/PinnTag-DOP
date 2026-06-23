import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { SeedingLogActions } from '../../../common/constants';

@Schema({ timestamps: true })
export class SeedingLog {
  @Prop({ type: Types.ObjectId, required: true, ref: 'SeedingSession', index: true })
  sessionId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'SeedingRecord' })
  recordId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: Object.values(SeedingLogActions) })
  action: string;

  @Prop({ type: String, required: true })
  actor: string;

  @Prop({ type: String })
  fromStatus: string;

  @Prop({ type: String })
  toStatus: string;

  @Prop({ type: String })
  message: string;

  @Prop({ type: Object })
  metadata: any;
}

export type SeedingLogDocument = SeedingLog & Document;
export const SeedingLogSchema = SchemaFactory.createForClass(SeedingLog);
