import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import type { ConsoleActionType } from './console.types';

// Runtime enum kept here for the @Prop enum: {...} constraint. The
// TypeScript-facing string-union lives in console.types.ts alongside
// the rest of the run/selection shapes; both must stay in sync.
export enum ConsoleRunStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  DONE = 'done',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Schema({ _id: false })
export class ConsoleRunLogEntry {
  @Prop({ type: Date, default: () => new Date() })
  ts: Date;

  @Prop({ type: String, default: 'info' })
  level: 'info' | 'warn' | 'error';

  @Prop({ type: String })
  message: string;
}
export const ConsoleRunLogEntrySchema =
  SchemaFactory.createForClass(ConsoleRunLogEntry);

@Schema({ timestamps: true, collection: 'dopConsoleRuns' })
export class ConsoleRun {
  @Prop({ type: String, required: true })
  action: ConsoleActionType;

  @Prop({ type: String, required: true })
  environment: string;

  // Human-readable summary of the selection at run start. Not the full
  // filter (too fat, and the query resolves live against the cursor
  // anyway) — just enough to know what the user hit "run" on when
  // reading the runs list later.
  @Prop({ type: Object })
  selectionSummary: Record<string, any>;

  @Prop({ type: Boolean, default: true })
  dryRun: boolean;

  @Prop({ type: Number, default: 0 })
  total: number;

  @Prop({ type: Number, default: 0 })
  processed: number;

  @Prop({ type: Number, default: 0 })
  succeeded: number;

  @Prop({ type: Number, default: 0 })
  failed: number;

  @Prop({ type: Number, default: 0 })
  skipped: number;

  @Prop({
    type: String,
    enum: Object.values(ConsoleRunStatus),
    default: ConsoleRunStatus.QUEUED,
  })
  status: ConsoleRunStatus;

  @Prop({ type: String })
  startedBy: string;

  @Prop({ type: Date })
  startedAt: Date;

  @Prop({ type: Date })
  finishedAt: Date;

  @Prop({ type: String })
  error: string;

  // Bounded — the tail of the log. New entries append; the head is
  // truncated at LOG_TAIL_LIMIT so a huge run doesn't blow up the doc.
  @Prop({ type: [ConsoleRunLogEntrySchema], default: [] })
  log: ConsoleRunLogEntry[];

  // Optional per-run summary payload (specific to the action). E.g.
  // resync_city might store its skippedAmbiguousSample here.
  @Prop({ type: Object })
  result: Record<string, any>;
}

export type ConsoleRunDocument = ConsoleRun & Document;
export const ConsoleRunSchema = SchemaFactory.createForClass(ConsoleRun);

ConsoleRunSchema.index({ createdAt: -1 });
ConsoleRunSchema.index({ status: 1, createdAt: -1 });
ConsoleRunSchema.index({ action: 1, createdAt: -1 });
