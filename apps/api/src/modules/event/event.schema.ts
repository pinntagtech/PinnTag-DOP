import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  EventTypes,
  EventStatus,
  DiscountType,
  RedemptionLimit,
} from '../../common/enums';

@Schema({ _id: false })
export class EventDuration {
  @Prop({ type: Date })
  startTime: Date;

  @Prop({ type: Date })
  endTime: Date;
}
export const EventDurationSchema =
  SchemaFactory.createForClass(EventDuration);

@Schema({ _id: false })
export class EventScheduleEntry {
  @Prop({ type: Date })
  date: Date;

  @Prop({ type: [EventDurationSchema] })
  durations: EventDuration[];
}
export const EventScheduleEntrySchema =
  SchemaFactory.createForClass(EventScheduleEntry);

@Schema({
  timestamps: true,
  toObject: { virtuals: true },
  toJSON: { virtuals: true },
})
export class Event {
  @Prop({ type: Boolean, default: false })
  isFromCrawler: boolean;

  @Prop({ type: Boolean, default: false })
  isFromFacebook: boolean;

  @Prop({ type: String, required: true, enum: Object.values(EventTypes) })
  type: string;

  @Prop({ type: String, enum: Object.values(DiscountType) })
  discountType: string;

  @Prop({ type: String })
  discountValue: string;

  @Prop({
    type: String,
    required: true,
    enum: ['User', 'BusinessUser'],
    default: 'BusinessUser',
  })
  creatorType: string;

  @Prop({ type: Types.ObjectId, refPath: 'creatorType' })
  user: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Business' })
  businessProfile: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(EventStatus),
    default: EventStatus.DRAFTED,
  })
  status: string;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Category' }] })
  categories: Types.ObjectId[];

  @Prop({ type: [{ type: Types.ObjectId, ref: 'ContentSubCategory' }] })
  subCategories: Types.ObjectId[];

  @Prop({ type: Types.ObjectId, ref: 'Folder' })
  drivePath: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'File' })
  QR_CODE: Types.ObjectId;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Image' }] })
  images: Types.ObjectId[];

  @Prop({ type: String })
  title: string;

  @Prop({ type: [String] })
  keywords: string[];

  @Prop({ type: String })
  description: string;

  @Prop({ type: [EventScheduleEntrySchema] })
  schedule: EventScheduleEntry[];

  @Prop({ type: [{ type: Types.ObjectId, ref: 'EventSchedule' }] })
  eventSchedule: Types.ObjectId[];

  @Prop({ type: [{ type: Types.ObjectId, ref: 'EventLocation' }] })
  locations: Types.ObjectId[];

  @Prop({ type: Number })
  minTargetAge: number;

  @Prop({ type: Number })
  maxTargetAge: number;

  @Prop({ type: [String] })
  targetGenders: string[];

  @Prop({ type: String })
  promotionCode: string;

  @Prop({ type: Boolean, default: false })
  isFree: boolean;

  @Prop({ type: Boolean, default: false })
  isFamilyFun: boolean;

  @Prop({ type: String })
  participationCost: string;

  @Prop({ type: [String] })
  bookingUrl: string[];

  @Prop({ type: Boolean, default: true })
  notifyFollowers: boolean;

  @Prop({ type: String, default: '' })
  RSVP: string;

  @Prop({ type: Boolean, default: false })
  termsApplied: boolean;

  @Prop({ type: String })
  termsAndConditions: string;

  @Prop({ type: Boolean, default: false })
  isPostedOnFacebook: boolean;

  @Prop({ type: Boolean, default: false })
  isScheduledToPostOnFB: boolean;

  @Prop({ type: String })
  facebookPostId: string;

  @Prop({ type: [String], default: [] })
  facebookScheduledPostIds: string[];

  @Prop({ type: Boolean, default: false })
  specifyForEachDay: boolean;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
  participants: Types.ObjectId[];

  @Prop({ type: String })
  offset: string;

  @Prop({ type: String })
  eventUrl: string;

  @Prop({
    type: [{ type: Types.ObjectId, ref: 'EventResponse' }],
    default: [],
  })
  responses: Types.ObjectId[];

  @Prop({ type: Number, default: 0 })
  viewsCount: number;

  @Prop({ type: Number, default: 0 })
  engagementCount: number;

  @Prop({ type: Number, default: 0 })
  quantityLimit: number;

  @Prop({ type: String })
  clientRefId: string;

  @Prop({ type: Number, default: 0 })
  totalLikes: number;

  @Prop({ type: Number, default: 0 })
  totalShares: number;

  @Prop({ type: Number, default: 0 })
  totalSaved: number;

  @Prop({ type: Boolean, default: false })
  date_range: boolean;

  @Prop({ type: Boolean, default: false })
  each_date: boolean;

  @Prop({ type: Boolean, default: false })
  isDisabled: boolean;

  @Prop({ type: Boolean, default: false })
  isSavedAsTemplate: boolean;

  @Prop({ type: [String] })
  tags: string[];

  @Prop({ type: String })
  itemName: string;

  @Prop({ type: Number })
  itemQuantity: number;

  @Prop({ type: Number, default: 1 })
  minOrderPerBooking: number;

  @Prop({ type: Number, default: 1 })
  maxOrderPerBooking: number;

  @Prop({ type: Number, min: 0, max: 9999 })
  itemPrice: number;

  @Prop({ type: String })
  currency: string;

  @Prop({ type: Boolean, default: false })
  preBookingRequired: boolean;

  @Prop({ type: Date })
  dealCollectionStartTime: Date;

  @Prop({ type: Date })
  flashDealEndTime: Date;

  @Prop({ type: Boolean, default: false })
  isCancellable: boolean;

  @Prop({ type: Number, default: 0 })
  cancellationWindow: number;

  @Prop({ type: Boolean })
  isRedeemable: boolean;

  @Prop({ type: String, enum: Object.values(RedemptionLimit) })
  redemptionFrequency: string;

  @Prop({ type: Boolean })
  checkInRequired: boolean;

  @Prop({ type: Boolean })
  expectedAtLocation: boolean;

  @Prop({ type: String })
  timezone: string;
}

export type EventDocument = Event & Document;
export const EventSchema = SchemaFactory.createForClass(Event);

// Indexes
EventSchema.index({ schedule: 1 });
EventSchema.index({ title: 'text', description: 'text' });

// Virtual: files
EventSchema.virtual('files', {
  ref: 'File',
  localField: 'drivePath',
  foreignField: 'parentDirectory',
});
