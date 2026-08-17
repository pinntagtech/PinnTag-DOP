import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum DiscoveryRunStatus {
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Schema({ _id: false })
export class RunParams {
  @Prop({ type: Number, required: true })
  limit!: number;

  @Prop({ type: Number, required: true })
  parallelism!: number;

  @Prop({ type: Number, required: true })
  minOvertureConfidence!: number;
}
export const RunParamsSchema = SchemaFactory.createForClass(RunParams);

@Schema({ _id: false })
export class RunStats {
  @Prop({ type: Number, default: 0 }) processed!: number;
  @Prop({ type: Number, default: 0 }) placesCallsTotal!: number;
  @Prop({ type: Number, default: 0 }) placesZeroResult!: number;
  @Prop({ type: Number, default: 0 }) claudeCalls!: number;
  @Prop({ type: Number, default: 0 }) claudeInputTokens!: number;
  @Prop({ type: Number, default: 0 }) claudeOutputTokens!: number;
  @Prop({ type: Number, default: 0 }) actionAccept!: number;
  @Prop({ type: Number, default: 0 }) actionReview!: number;
  @Prop({ type: Number, default: 0 }) actionSkip!: number;
  @Prop({ type: Number, default: 0 }) actionNotApplicable!: number;
  @Prop({ type: Number, default: 0 }) actionZeroResultNoInsert!: number;
  @Prop({ type: Number, default: 0 }) errorCount!: number;

  // Ollama health watermark. `localLlmCalls` counts every askJson issued
  // from this run's judge invocations; `localLlmNullReturns` counts those
  // that returned null (HTTP failure, network error, timeout, or bad
  // JSON) — each of which the judges convert into a confidence=0
  // placeholder → needsReview via the 0.9 gate. High values indicate
  // Ollama was unreachable/overloaded and the run's review pile is
  // largely infrastructure noise rather than genuine ambiguity.
  @Prop({ type: Number, default: 0 }) localLlmCalls!: number;
  @Prop({ type: Number, default: 0 }) localLlmNullReturns!: number;
}
export const RunStatsSchema = SchemaFactory.createForClass(RunStats);

@Schema({ timestamps: true, collection: 'discoveryRuns' })
export class DiscoveryRun {
  @Prop({ type: String, required: true, unique: true })
  runId!: string;

  @Prop({ type: String, required: true, index: true })
  regionId!: string;

  @Prop({
    type: String,
    enum: DiscoveryRunStatus,
    default: DiscoveryRunStatus.RUNNING,
  })
  status!: DiscoveryRunStatus;

  @Prop({ type: RunParamsSchema, required: true })
  params!: RunParams;

  @Prop({ type: RunStatsSchema, default: () => ({}) })
  stats!: RunStats;

  @Prop({ type: Date, default: () => new Date() })
  startedAt!: Date;

  @Prop({ type: Date, default: null })
  completedAt?: Date | null;

  @Prop({ type: String, default: null })
  error?: string | null;
}
export type DiscoveryRunDocument = DiscoveryRun & Document;
export const DiscoveryRunSchema = SchemaFactory.createForClass(DiscoveryRun);
