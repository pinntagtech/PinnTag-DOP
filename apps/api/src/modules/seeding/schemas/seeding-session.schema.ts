import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';
import {
  SeedingEnvironments,
  SeedingSessionStatus,
  SeedingSessionType,
  SeedingDefaults,
} from '../../../common/constants';

@Schema({ _id: false })
export class SessionStats {
  @Prop({ type: Number, default: 0 })
  raw: number;

  @Prop({ type: Number, default: 0 })
  validated: number;

  @Prop({ type: Number, default: 0 })
  transformed: number;

  @Prop({ type: Number, default: 0 })
  enriched: number;

  @Prop({ type: Number, default: 0 })
  ready: number;

  @Prop({ type: Number, default: 0 })
  published: number;

  @Prop({ type: Number, default: 0 })
  failed: number;

  @Prop({ type: Number, default: 0 })
  skipped: number;
}
export const SessionStatsSchema =
  SchemaFactory.createForClass(SessionStats);

@Schema({ _id: false })
export class BotOperationStat {
  @Prop({ type: Date, default: null })
  lastRunAt: Date | null;

  @Prop({ type: Number, default: 0 })
  doneCount: number;

  @Prop({ type: Number, default: 0 })
  failedCount: number;
}
export const BotOperationStatSchema =
  SchemaFactory.createForClass(BotOperationStat);

@Schema({ _id: false })
export class BotOperationsMap {
  @Prop({ type: BotOperationStatSchema, default: () => ({}) })
  reviews: BotOperationStat;

  @Prop({ type: BotOperationStatSchema, default: () => ({}) })
  galleryMenu: BotOperationStat;

  @Prop({ type: BotOperationStatSchema, default: () => ({}) })
  imageSync: BotOperationStat;

  @Prop({ type: BotOperationStatSchema, default: () => ({}) })
  coverSync: BotOperationStat;
}
export const BotOperationsMapSchema =
  SchemaFactory.createForClass(BotOperationsMap);

@Schema({ timestamps: true })
export class SeedingSession {
  @Prop({ type: String, unique: true })
  sessionId: string;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String })
  description: string;

  @Prop({ type: String, required: true })
  createdBy: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(SeedingEnvironments),
  })
  environment: string;

  @Prop({
    type: String,
    enum: Object.values(SeedingSessionStatus),
    default: SeedingSessionStatus.DRAFT,
  })
  status: string;

  @Prop({ type: Number, default: 0 })
  totalRecords: number;

  @Prop({ type: SessionStatsSchema, default: () => ({}) })
  stats: SessionStats;

  @Prop({ type: BotOperationsMapSchema, default: () => ({}) })
  botOperations: BotOperationsMap;

  @Prop({ type: [String] })
  modules: string[];

  @Prop({ type: Date })
  publishedAt: Date;

  @Prop({ type: String })
  publishedBy: string;

  @Prop({ type: String })
  errorSummary: string;

  @Prop({ type: Object })
  metadata: any;

  @Prop({
    type: String,
    enum: Object.values(SeedingSessionType),
    default: SeedingSessionType.STANDARD,
  })
  type: string;

  @Prop({
    type: {
      sessionId: { type: mongoose.Schema.Types.ObjectId },
      sessionName: { type: String },
      environment: { type: String },
      migratedAt: { type: Date },
    },
    default: null,
  })
  migratedFrom?: {
    sessionId: mongoose.Types.ObjectId;
    sessionName: string;
    environment: string;
    migratedAt: Date;
  };

  @Prop({ type: String, default: null })
  dominantCity?: string | null;

  @Prop({ type: String, default: null })
  dominantState?: string | null;

  @Prop({ type: String, default: null })
  dominantIndustry?: string | null;

  @Prop({ type: String, default: null })
  dominantCategory?: string | null;

  @Prop({
    type: [
      {
        _id: false,
        environment: { type: String },
        sessionId: { type: mongoose.Schema.Types.ObjectId },
        migratedAt: { type: Date },
      },
    ],
    default: [],
  })
  migratedTo: {
    environment: string;
    sessionId: mongoose.Types.ObjectId;
    migratedAt: Date;
  }[];
}

export type SeedingSessionDocument = SeedingSession & Document;
export const SeedingSessionSchema =
  SchemaFactory.createForClass(SeedingSession);

SeedingSessionSchema.pre('save', function () {
  if (!this.sessionId) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const letters = Array.from(
      { length: SeedingDefaults.SESSION_ID_RANDOM_LENGTH },
      () => String.fromCharCode(65 + Math.floor(Math.random() * 26)),
    ).join('');
    this.sessionId = `${SeedingDefaults.SESSION_ID_PREFIX}-${yyyy}${mm}${dd}-${letters}`;
  }
});
