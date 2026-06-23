import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum BotJobStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  DONE = 'done',
  FAILED = 'failed',
}

export enum BotJobType {
  GALLERY_MENU = 'gallery_menu',
  REVIEWS = 'reviews',
  IMAGE_SYNC = 'image_sync',
  COVER_SYNC = 'cover_sync',
  RESOLVE_BUSINESS = 'resolve_business',
}

@Schema({ timestamps: true, collection: 'dopBotJobs' })
export class BotJob {
  // Optional for resolve_business — those jobs may run from address alone
  // when no valid ChIJ placeId is on record yet. Required in practice for
  // every other job type; the bot guards on this.
  @Prop({ required: false, default: '' })
  placeId: string;

  @Prop({ required: true })
  businessId: string;

  @Prop({ required: true })
  businessName: string;

  @Prop({ required: true })
  environment: string;

  @Prop({ required: false, default: '' })
  sessionId: string;

  @Prop({ type: String, enum: BotJobType, required: true })
  type: BotJobType;

  @Prop({ type: String, enum: BotJobStatus, default: BotJobStatus.PENDING })
  status: BotJobStatus;

  @Prop({ type: Number, default: 100 })
  maxReviews: number;

  // Address payload carried for resolve_business — Google Maps search
  // URL is built from these when placeId is missing/invalid.
  @Prop({ type: String, default: '' })
  addressLine1: string;

  @Prop({ type: String, default: '' })
  city: string;

  @Prop({ type: String, default: '' })
  state: string;

  @Prop({ type: String, default: '' })
  postalCode: string;

  @Prop({ type: Date, default: null })
  claimedAt?: Date;

  @Prop({ type: Date, default: null })
  completedAt?: Date;

  @Prop({ type: String, default: null })
  error?: string;

  @Prop({ type: Number, default: 0 })
  attempts!: number;
}

export type BotJobDocument = BotJob & Document;
export const BotJobSchema = SchemaFactory.createForClass(BotJob);

BotJobSchema.index({ status: 1, createdAt: 1 });
BotJobSchema.index({ sessionId: 1 });
