import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ProfileStatus, BusinessUserCreatorType } from '../../common/enums';

@Schema({ timestamps: true })
export class BusinessUser {
  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Boolean, default: false })
  isBlocked: boolean;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Role' }] })
  role: Types.ObjectId[];

  @Prop({
    type: Number,
    required: true,
    enum: Object.values(ProfileStatus),
    default: ProfileStatus.INITIATED,
  })
  status: number;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Types.ObjectId, ref: 'BusinessUser' })
  creator: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(BusinessUserCreatorType),
  })
  creatorType: string;

  @Prop({
    type: String,
    default:
      'https://pinntag-assets.s3.us-east-1.amazonaws.com/Defaults/Default+business+user.png',
  })
  profilePhoto: string;

  @Prop({
    type: String,
    default:
      'https://pinntag-assets.s3.us-east-1.amazonaws.com/Defaults/Default+business+user.png',
  })
  profilePhotoThumbnail: string;

  @Prop({ type: String })
  name: string;

  @Prop({ type: String })
  countryCode: string;

  @Prop({ type: String })
  phone: string;

  @Prop({ type: String, unique: true, sparse: true })
  fullPhoneNumber: string;

  @Prop({ type: String, unique: true, sparse: true })
  email: string;

  @Prop({ type: Boolean, default: false })
  isEmailVerified: boolean;

  @Prop({ type: Boolean, default: false })
  isMobileVerified: boolean;

  @Prop({ type: Boolean, default: false })
  appleLoggedIn: boolean;

  @Prop({ type: Boolean, default: false })
  googleLoggedIn: boolean;

  @Prop({ type: String })
  password: string;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Business' }] })
  business: Types.ObjectId[];

  @Prop({ type: Types.ObjectId, ref: 'Business' })
  selectedBusiness: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  drive: Types.ObjectId;

  @Prop({ type: Boolean, default: false })
  forcePasswordReset: boolean;

  @Prop({ type: [{ type: Types.ObjectId }] })
  assignedOutlets: Types.ObjectId[];

  @Prop({ type: Boolean, default: false })
  webWalkThroughCompleted: boolean;

  @Prop({ type: Boolean, default: false })
  appWalkThroughCompleted: boolean;
}

export type BusinessUserDocument = BusinessUser & Document;
export const BusinessUserSchema =
  SchemaFactory.createForClass(BusinessUser);
