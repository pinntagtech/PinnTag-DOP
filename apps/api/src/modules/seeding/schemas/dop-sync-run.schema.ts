import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ _id: false })
export class DopSyncRunTotals {
  @Prop({ type: Number, default: 0 }) targeted: number;
  @Prop({ type: Number, default: 0 }) toPatch: number;
  @Prop({ type: Number, default: 0 }) alreadySynced: number;
  @Prop({ type: Number, default: 0 }) assertionFailed: number;
  @Prop({ type: Number, default: 0 }) missingInTarget: number;
  @Prop({ type: Number, default: 0 }) coverageGap: number;
}
export const DopSyncRunTotalsSchema =
  SchemaFactory.createForClass(DopSyncRunTotals);

@Schema({ _id: false })
export class DopSyncRunResult {
  @Prop({ type: String }) businessId: string;
  @Prop({ type: String }) sessionId?: string;
  @Prop({ type: String }) recordId?: string;
  @Prop({
    type: String,
    enum: ['patched', 'skipped', 'failed', 'assertion_failed', 'missing'],
  })
  outcome: string;
  @Prop({ type: [String], default: [] }) changedFields: string[];
  @Prop({ type: String }) error?: string;
}
export const DopSyncRunResultSchema =
  SchemaFactory.createForClass(DopSyncRunResult);

@Schema({ collection: 'dopSyncRuns', timestamps: true })
export class DopSyncRun {
  @Prop({ type: String, required: true, index: true })
  environment: string;

  @Prop({
    type: String,
    enum: ['previewing', 'previewed', 'applying', 'completed', 'failed'],
    required: true,
  })
  status: string;

  @Prop({ type: String, required: true })
  startedBy: string;

  @Prop({ type: Date, default: Date.now })
  startedAt: Date;

  @Prop({ type: Date })
  finishedAt?: Date;

  @Prop({ type: DopSyncRunTotalsSchema, default: () => ({}) })
  totals: DopSyncRunTotals;

  @Prop({ type: [DopSyncRunResultSchema], default: [] })
  results: DopSyncRunResult[];

  @Prop({ type: String })
  errorMessage?: string;
}

export type DopSyncRunDocument = DopSyncRun & Document;
export const DopSyncRunSchema = SchemaFactory.createForClass(DopSyncRun);
DopSyncRunSchema.index({ environment: 1, createdAt: -1 });

@Schema({ collection: 'dopSyncState', timestamps: true })
export class DopSyncState {
  @Prop({ type: String, required: true, index: true })
  environment: string;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  businessId: Types.ObjectId;

  @Prop({ type: Number, required: true })
  syncVersion: number;

  @Prop({ type: Date, default: Date.now })
  syncedAt: Date;
}

export type DopSyncStateDocument = DopSyncState & Document;
export const DopSyncStateSchema = SchemaFactory.createForClass(DopSyncState);
DopSyncStateSchema.index(
  { environment: 1, businessId: 1 },
  { unique: true },
);
