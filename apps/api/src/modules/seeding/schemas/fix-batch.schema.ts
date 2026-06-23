import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// Per-business summary buckets stored on the batch so the email body
// can show 2-3 example names per outcome without a second DB round
// trip. Cap enforced server-side by FixBatchService when pushing.
@Schema({ _id: false })
export class FixBatchExample {
  @Prop({ type: String, required: true })
  businessId: string;

  @Prop({ type: String, default: '' })
  businessName: string;

  // Only populated on needsReview entries — short reason code
  // (e.g. 'name_mismatch', 'hours_no_days_parsed'). Other buckets
  // leave this empty.
  @Prop({ type: String, default: '' })
  reason: string;
}
export const FixBatchExampleSchema =
  SchemaFactory.createForClass(FixBatchExample);

@Schema({ _id: false })
export class FixBatchCounts {
  // Increments when the cascade actually wrote regularTiming on this
  // run (i.e. hours parsed cleanly).
  @Prop({ type: Number, default: 0 })
  hours: number;

  // Increments when a numeric rating was captured + written.
  @Prop({ type: Number, default: 0 })
  rating: number;

  // Increments when step 3 of the cascade synced a cover to B2 OR
  // when the resolve run skipped because a cover was already set.
  // Both are operator-visible wins — only "failed" / "not staged" is
  // excluded.
  @Prop({ type: Number, default: 0 })
  cover: number;

  // Increments when step 2 auto-applied a mapped taxonomy this run.
  // 'correct' (already correct, no write) does NOT count here — we
  // only count corrections.
  @Prop({ type: Number, default: 0 })
  taxonomy: number;
}
export const FixBatchCountsSchema =
  SchemaFactory.createForClass(FixBatchCounts);

@Schema({ _id: false })
export class FixBatchExamples {
  @Prop({ type: [FixBatchExampleSchema], default: [] })
  fullyFixed: FixBatchExample[];

  @Prop({ type: [FixBatchExampleSchema], default: [] })
  hours: FixBatchExample[];

  @Prop({ type: [FixBatchExampleSchema], default: [] })
  rating: FixBatchExample[];

  @Prop({ type: [FixBatchExampleSchema], default: [] })
  cover: FixBatchExample[];

  @Prop({ type: [FixBatchExampleSchema], default: [] })
  taxonomy: FixBatchExample[];

  @Prop({ type: [FixBatchExampleSchema], default: [] })
  needsReview: FixBatchExample[];
}
export const FixBatchExamplesSchema =
  SchemaFactory.createForClass(FixBatchExamples);

export enum FixBatchStatus {
  RUNNING = 'running',
  COMPLETE = 'complete',
}

// One doc per "Fix selected" trigger from the operator. The webhook
// looks the doc up by businessId membership + status='running' to
// attribute each cascade completion. When done === total, an atomic
// findOneAndUpdate flips status to 'complete' (guarded so only one
// caller wins) and fires the summary notifier.
@Schema({
  timestamps: true,
  collection: 'dopFixBatches',
})
export class FixBatch {
  // Short human-friendly id (e.g. 'fixb-2026-06-20-7a3b'). Indexed
  // unique. Surfaced in subject + portal deep-link.
  @Prop({ type: String, required: true, unique: true })
  batchId: string;

  @Prop({ type: String, required: true })
  environment: string;

  // Optional label — when the operator triggered from a city-filtered
  // candidates view, this carries that filter so the subject can say
  // "DOP Fix complete — <city> — N/M fixed". Free-form string.
  @Prop({ type: String, default: '' })
  city: string;

  @Prop({ type: [String], required: true })
  businessIds: string[];

  @Prop({ type: Number, required: true })
  total: number;

  @Prop({ type: Number, default: 0 })
  done: number;

  @Prop({ type: Number, default: 0 })
  fullyFixed: number;

  @Prop({ type: Number, default: 0 })
  needsReview: number;

  @Prop({ type: FixBatchCountsSchema, default: () => ({}) })
  counts: FixBatchCounts;

  @Prop({ type: FixBatchExamplesSchema, default: () => ({}) })
  examples: FixBatchExamples;

  // Snapshot of the NOTIFY_EMAILS list at batch-create time. Stored
  // on the doc (rather than re-read from env at notify time) so
  // mid-batch config changes don't mis-route the summary.
  @Prop({ type: [String], default: [] })
  recipientEmails: string[];

  @Prop({
    type: String,
    enum: FixBatchStatus,
    default: FixBatchStatus.RUNNING,
  })
  status: FixBatchStatus;

  // Timestamp of the notifier fire so the email can include "completed
  // at X". Distinct from updatedAt (which moves on every recordOutcome
  // call). Set inside the same findOneAndUpdate that flips to
  // 'complete'.
  @Prop({ type: Date, default: null })
  completedAt?: Date;
}

export type FixBatchDocument = FixBatch & Document;
export const FixBatchSchema = SchemaFactory.createForClass(FixBatch);

// Lookup paths used by the webhook attribution query + the notifier
// dedupe guard.
FixBatchSchema.index({ businessIds: 1, status: 1 });
FixBatchSchema.index({ status: 1, createdAt: -1 });
