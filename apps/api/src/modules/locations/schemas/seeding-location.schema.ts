import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';

@Schema({ _id: false })
export class LocationArea {
  @Prop({ required: true })
  name: string;

  @Prop({ type: String })
  subRegion?: string;

  // Per-area state override (e.g. NYC's "Jersey Side" -> NJ).
  // When set, takes precedence over the city's state for businesses
  // resolved into this area.
  @Prop({ type: String })
  state?: string;
}
export const LocationAreaSchema = SchemaFactory.createForClass(LocationArea);

@Schema({ timestamps: true, collection: 'seedingLocations' })
export class SeedingLocation {
  // Display name as operators see it (preserves casing).
  @Prop({ required: true })
  city: string;

  // Lowercased mirror of `city` for case-insensitive unique constraint
  // and fast lookups.
  @Prop({ required: true, unique: true, index: true, lowercase: true })
  cityKey: string;

  // Default 2-letter US state code for this city.
  @Prop({ required: true })
  state: string;

  @Prop({ type: [LocationAreaSchema], default: [] })
  areas: LocationArea[];

  @Prop({ default: true })
  isActive: boolean;

  @Prop({
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DopUser',
    default: null,
  })
  createdBy?: mongoose.Types.ObjectId;
}

export type SeedingLocationDocument = SeedingLocation & Document;
export const SeedingLocationSchema =
  SchemaFactory.createForClass(SeedingLocation);
