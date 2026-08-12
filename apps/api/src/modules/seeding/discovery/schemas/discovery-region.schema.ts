import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum DiscoveryRegionStatus {
  PENDING = 'pending',
  DISCOVERING = 'discovering',
  DONE = 'done',
}

@Schema({ _id: false })
export class RegionBbox {
  @Prop({ type: Number, required: true })
  west!: number;

  @Prop({ type: Number, required: true })
  south!: number;

  @Prop({ type: Number, required: true })
  east!: number;

  @Prop({ type: Number, required: true })
  north!: number;
}

export const RegionBboxSchema = SchemaFactory.createForClass(RegionBbox);

@Schema({ _id: false })
export class RegionStats {
  @Prop({ type: Date, default: null })
  lastPreviewAt?: Date | null;

  @Prop({ type: Number, default: 0 })
  totalOvertureCandidates!: number;

  @Prop({ type: Number, default: 0 })
  alreadyInCorpus!: number;

  @Prop({ type: Number, default: 0 })
  newCandidates!: number;
}

export const RegionStatsSchema = SchemaFactory.createForClass(RegionStats);

@Schema({ timestamps: true, collection: 'discoveryRegions' })
export class DiscoveryRegion {
  @Prop({ type: String, required: true, unique: true })
  regionId!: string;

  @Prop({ type: String, required: true })
  name!: string;

  @Prop({ type: String, required: true })
  state!: string;

  @Prop({ type: RegionBboxSchema, required: true })
  bbox!: RegionBbox;

  @Prop({ type: Number, default: 100 })
  priority!: number;

  @Prop({
    type: String,
    enum: DiscoveryRegionStatus,
    default: DiscoveryRegionStatus.PENDING,
  })
  status!: DiscoveryRegionStatus;

  @Prop({ type: [String], default: undefined })
  categories?: string[];

  @Prop({ type: RegionStatsSchema, default: () => ({}) })
  stats!: RegionStats;
}

export type DiscoveryRegionDocument = DiscoveryRegion & Document;
export const DiscoveryRegionSchema =
  SchemaFactory.createForClass(DiscoveryRegion);

DiscoveryRegionSchema.index({ priority: 1, status: 1 });
