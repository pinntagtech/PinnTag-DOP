import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { OutletCategoryList } from '../../common/enums';
import {
  Hours,
  HoursSchema,
  LocationType,
  LocationTypeSchema,
} from '../../common/schemas/shared.schema';

@Schema({ timestamps: true })
export class Outlet {
  @Prop({ type: String, enum: Object.values(OutletCategoryList) })
  category: string;

  @Prop({ type: Boolean, default: false })
  isFromCrawler: boolean;

  @Prop({ type: String })
  refId: string;

  @Prop({ type: String })
  placeId: string;

  @Prop({ type: String })
  name: string;

  @Prop({ type: Types.ObjectId, ref: 'BusinessUser' })
  manager: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'BusinessUser' })
  creator: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Business' })
  business: Types.ObjectId;

  @Prop({ type: String })
  address1: string;

  @Prop({ type: String })
  description: string;

  @Prop({ type: String })
  address2: string;

  @Prop({ type: String })
  city: string;

  @Prop({ type: String })
  state: string;

  @Prop({ type: String })
  country: string;

  @Prop({ type: String })
  postalCode: string;

  @Prop({ type: String })
  countryCode: string;

  @Prop({ type: String })
  phone: string;

  @Prop({ type: String })
  email: string;

  @Prop({ type: Number, default: 60 })
  servingRadius: number;

  @Prop({ type: String })
  whatsappNumber: string;

  @Prop({ type: String })
  website: string;

  @Prop({ type: String })
  facebook: string;

  @Prop({ type: String })
  instagram: string;

  @Prop({ type: String })
  twitter: string;

  @Prop({ type: String })
  vehicleType: string;

  @Prop({ type: String })
  vehicleRegistrationNumber: string;

  @Prop({ type: Number })
  latitude: number;

  @Prop({ type: Number })
  longitude: number;

  @Prop({ type: String })
  locality: string;

  @Prop({ type: Number })
  accuracy: number;

  @Prop({ type: LocationTypeSchema })
  location: LocationType;

  @Prop({ type: HoursSchema })
  openingTime: Hours;

  @Prop({ type: HoursSchema })
  closingTime: Hours;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: String })
  cover: string;

  @Prop({ type: String })
  coverThumbnail: string;

  @Prop({ type: Types.ObjectId, ref: 'Folder' })
  drivePath: Types.ObjectId;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'MobileSpots' }] })
  spots: Types.ObjectId[];

  @Prop({ type: Boolean, default: false })
  isActive: boolean;

  @Prop({ type: Types.ObjectId, ref: 'Pindrop' })
  pinDrop: Types.ObjectId;

  @Prop({ type: Number, default: 0 })
  viewsCount: number;
}

export type OutletDocument = Outlet & Document;
export const OutletSchema = SchemaFactory.createForClass(Outlet);

OutletSchema.index({ location: '2dsphere' });
OutletSchema.index({ isDeleted: 1 });
