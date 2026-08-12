// One doc per (regionId, overtureSourceId) EVER processed by a
// discovery run — regardless of the final action. Enables resumable
// batching: on run start we load the set of already-processed sourceIds
// for the region and skip them, so a crashed multi-hour run doesn't
// re-spend Places / Claude calls on candidates it already handled.
//
// The unique (regionId, overtureSourceId) index doubles as a safety
// net against 10-way concurrency accidentally handling the same
// sourceId twice.

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DiscoveryFinalAction =
  | 'accept'
  | 'review'
  | 'skip'
  | 'not_applicable'
  | 'zero_result';

@Schema({ timestamps: true, collection: 'discoveryProcessed' })
export class DiscoveryProcessed {
  @Prop({ type: String, required: true, index: true })
  regionId!: string;

  @Prop({ type: String, required: true })
  overtureSourceId!: string;

  @Prop({ type: String, required: true, index: true })
  runId!: string;

  @Prop({ type: String, required: true })
  action!: DiscoveryFinalAction;

  // Populated when a business was actually inserted (accept | review).
  @Prop({ type: String, default: null })
  businessId?: string | null;

  // Google-resolved placeId if Places returned one. Useful for cross-run
  // dedup diagnostics.
  @Prop({ type: String, default: null })
  resolvedPlaceId?: string | null;

  @Prop({ type: String, default: null })
  reasoning?: string | null;
}

export type DiscoveryProcessedDocument = DiscoveryProcessed & Document;
export const DiscoveryProcessedSchema =
  SchemaFactory.createForClass(DiscoveryProcessed);

DiscoveryProcessedSchema.index(
  { regionId: 1, overtureSourceId: 1 },
  { unique: true },
);
