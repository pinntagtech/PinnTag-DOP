import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';

export enum DopUserRole {
  SUPER_ADMIN = 'super_admin',
  ADMIN = 'admin',
  OPERATOR = 'operator',
}

export type DopUserDocument = DopUser & Document;

@Schema({ timestamps: true, collection: 'dopusers' })
export class DopUser {
  @Prop({ required: true, unique: true, lowercase: true })
  email: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ required: true })
  name: string;

  @Prop({
    type: String,
    enum: DopUserRole,
    default: DopUserRole.OPERATOR,
  })
  role: DopUserRole;

  @Prop({
    type: [String],
    default: ['dev'],
  })
  environments: string[];

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  isRootAdmin: boolean;

  @Prop({
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DopUser',
    default: null,
  })
  createdBy?: mongoose.Types.ObjectId;

  @Prop({ type: Date, default: null })
  lastLoginAt?: Date;
}

export const DopUserSchema = SchemaFactory.createForClass(DopUser);
