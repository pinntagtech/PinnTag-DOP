import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';

export type AuditLogDocument = AuditLog & Document;

@Schema({
  timestamps: true,
  collection: 'dopAuditLogs',
  capped: { size: 100 * 1024 * 1024, max: 100000 },
})
export class AuditLog {
  @Prop({
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DopUser',
    index: true,
  })
  userId: mongoose.Types.ObjectId;

  @Prop({ required: true })
  userEmail: string;

  @Prop({ required: true })
  userName: string;

  @Prop({ required: true, index: true })
  action: string;

  @Prop({ required: true })
  resource: string;

  @Prop({ type: String, default: null, index: true })
  resourceId?: string;

  @Prop({ type: mongoose.Schema.Types.Mixed, default: {} })
  details: Record<string, any>;

  @Prop({ type: String, default: null })
  environment?: string;

  @Prop({ type: String, default: null })
  ip?: string;

  @Prop({ type: String, default: null })
  userAgent?: string;

  @Prop({
    type: String,
    enum: ['success', 'failure', 'warning'],
    default: 'success',
  })
  outcome: string;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
