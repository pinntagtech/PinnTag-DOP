import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';

export type RefreshTokenDocument = RefreshToken & Document;

@Schema({ timestamps: true, collection: 'dopRefreshTokens' })
export class RefreshToken {
  @Prop({
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DopUser',
    required: true,
    index: true,
  })
  userId: mongoose.Types.ObjectId;

  @Prop({ required: true })
  tokenHash: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: String, default: null })
  ip?: string;

  @Prop({ type: String, default: null })
  userAgent?: string;

  @Prop({ type: Date, default: null })
  revokedAt?: Date;
}

export const RefreshTokenSchema =
  SchemaFactory.createForClass(RefreshToken);
