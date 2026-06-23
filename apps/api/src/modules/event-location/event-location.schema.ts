import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  LocationType,
  LocationTypeSchema,
} from '../../common/schemas/shared.schema';

@Schema({ timestamps: true })
export class EventLocation {
  @Prop({ type: Boolean, default: false })
  isFromCrawler: boolean;

  @Prop({ type: Types.ObjectId, required: true, ref: 'Event' })
  event: Types.ObjectId;

  @Prop({ type: LocationTypeSchema })
  location: LocationType;

  @Prop({ type: Types.ObjectId, ref: 'Outlet' })
  businessLocationId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Business' })
  businessProfile: Types.ObjectId;

  @Prop({ type: Number })
  accuracy: number;

  @Prop({ type: String })
  address1: string;

  @Prop({ type: String })
  address2: string;

  @Prop({ type: String })
  city: string;

  @Prop({ type: String })
  state: string;

  @Prop({ type: String })
  locality: string;

  @Prop({ type: String })
  zip: string;

  @Prop({ type: String })
  website: string;

  @Prop({ type: String })
  email: string;

  @Prop({ type: String })
  phone: string;

  @Prop({ type: Types.ObjectId, ref: 'MobileSpots' })
  spotId: Types.ObjectId;
}

export type EventLocationDocument = EventLocation & Document;
export const EventLocationSchema =
  SchemaFactory.createForClass(EventLocation);

EventLocationSchema.index({ location: '2dsphere' });
