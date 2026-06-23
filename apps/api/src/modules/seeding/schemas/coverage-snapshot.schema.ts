import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ _id: false })
export class CoverageSnapshotTotals {
  @Prop({ type: Number, default: 0 }) seeded: number;
  @Prop({ type: Number, default: 0 }) published: number;
  @Prop({ type: Number, default: 0 }) publishRate: number;
  // null when the prod connection failed — do NOT fabricate a number.
  @Prop({ type: Number, default: null }) liveInProduction: number | null;
  @Prop({ type: Number, default: 0 }) citiesCovered: number;
  @Prop({ type: Number, default: 11 }) hostMetros: number;
}
export const CoverageSnapshotTotalsSchema = SchemaFactory.createForClass(
  CoverageSnapshotTotals,
);

@Schema({ _id: false })
export class CoverageByCity {
  @Prop({ type: String, required: true }) city: string;
  @Prop({ type: String, default: null }) state: string | null;
  @Prop({ type: Number, default: 0 }) published: number;
  @Prop({ type: Number, default: 0 }) total: number;
  @Prop({ type: Number, default: 0 }) pending: number;
}
export const CoverageByCitySchema = SchemaFactory.createForClass(CoverageByCity);

@Schema({ _id: false })
export class CoverageProdVsStaging {
  @Prop({ type: Number, default: 0 }) published: number;
  @Prop({ type: Number, default: null }) liveInProduction: number | null;
}
export const CoverageProdVsStagingSchema = SchemaFactory.createForClass(
  CoverageProdVsStaging,
);

@Schema({ _id: false })
export class CoverageCitySharePublished {
  @Prop({ type: String, required: true }) city: string;
  @Prop({ type: Number, default: 0 }) published: number;
}
export const CoverageCitySharePublishedSchema = SchemaFactory.createForClass(
  CoverageCitySharePublished,
);

@Schema({ collection: 'coverageSnapshots', timestamps: true })
export class CoverageSnapshot {
  @Prop({ type: Date, default: Date.now, index: true })
  generatedAt: Date;

  @Prop({ type: String, required: true })
  generatedBy: string;

  @Prop({ type: CoverageSnapshotTotalsSchema, default: () => ({}) })
  totals: CoverageSnapshotTotals;

  @Prop({ type: [CoverageByCitySchema], default: [] })
  byCity: CoverageByCity[];

  @Prop({ type: CoverageProdVsStagingSchema, default: () => ({}) })
  prodVsStaging: CoverageProdVsStaging;

  @Prop({ type: [CoverageCitySharePublishedSchema], default: [] })
  citySharePublished: CoverageCitySharePublished[];

  // Populated when the production count could not be retrieved — UI
  // shows "unavailable" instead of a fake number.
  @Prop({ type: String, default: null })
  prodConnectionError: string | null;
}

export type CoverageSnapshotDocument = CoverageSnapshot & Document;
export const CoverageSnapshotSchema =
  SchemaFactory.createForClass(CoverageSnapshot);
CoverageSnapshotSchema.index({ generatedAt: -1 });
