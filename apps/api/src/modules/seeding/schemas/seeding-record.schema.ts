import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document, Types } from 'mongoose';
import {
  SeedingModules,
  SeedingRecordStatus,
  ValidationSeverity,
} from '../../../common/constants';

@Schema({ _id: false })
export class ValidationError {
  @Prop({ type: String })
  field: string;

  @Prop({ type: String })
  message: string;

  @Prop({ type: String, enum: Object.values(ValidationSeverity) })
  severity: string;
}
export const ValidationErrorSchema =
  SchemaFactory.createForClass(ValidationError);

@Schema({ timestamps: true })
export class SeedingRecord {
  @Prop({ type: Types.ObjectId, required: true, ref: 'SeedingSession', index: true })
  sessionId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: Object.values(SeedingModules) })
  module: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(SeedingRecordStatus),
    default: SeedingRecordStatus.RAW,
  })
  status: string;

  @Prop({ type: Object, required: true })
  rawData: any;

  @Prop({ type: Object })
  transformedData: any;

  @Prop({ type: [ValidationErrorSchema], default: [] })
  validationErrors: ValidationError[];

  @Prop({ type: Object })
  enrichmentData: any;

  @Prop({ type: String })
  enrichmentSource: string;

  @Prop({ type: String })
  publishedId: string;

  @Prop({ type: Date })
  publishedAt: Date;

  @Prop({ type: Number, default: 0 })
  retryCount: number;

  @Prop({ type: String })
  errorMessage: string;

  @Prop({ type: String })
  clientRefId: string;

  @Prop({ type: Object })
  metadata: any;

  @Prop({
    type: {
      status: { type: String, default: 'pending' },
      startedAt: { type: Date },
      completedAt: { type: Date },
      currentStage: { type: String },
      currentDetail: { type: String },
      progress: {
        gallery: {
          status: { type: String, default: 'pending' },
          folders: { type: Number, default: 0 },
          images: { type: Number, default: 0 },
          currentFolder: { type: String },
          foldersTotal: { type: Number, default: 0 },
        },
        menu: {
          status: { type: String, default: 'pending' },
          items: { type: Number, default: 0 },
        },
        reviews: {
          status: { type: String, default: 'pending' },
          current: { type: Number, default: 0 },
          total: { type: Number, default: 0 },
          expanding: { type: Number, default: 0 },
        },
      },
      reviewCount: { type: Number, default: 0 },
      galleryFolders: { type: Number, default: 0 },
      galleryImages: { type: Number, default: 0 },
      menuItems: { type: Number, default: 0 },
      error: { type: String },
    },
    default: null,
  })
  botScrape?: {
    status: string;
    startedAt?: Date;
    completedAt?: Date;
    currentStage?: string;
    currentDetail?: string;
    progress?: {
      gallery?: {
        status: string;
        folders: number;
        images: number;
        currentFolder?: string;
        foldersTotal: number;
      };
      menu?: {
        status: string;
        items: number;
      };
      reviews?: {
        status: string;
        current: number;
        total: number;
        expanding: number;
      };
    };
    reviewCount?: number;
    galleryFolders?: number;
    galleryImages?: number;
    menuItems?: number;
    error?: string;
  };

  @Prop({ type: String })
  cvbBusinessId?: string;

  @Prop({
    type: [{
      field: String,
      issue: String,
      currentValue: mongoose.Schema.Types.Mixed,
      suggestedValue: mongoose.Schema.Types.Mixed,
      riskLevel: {
        type: String,
        enum: ['safe', 'manual'],
        default: 'safe',
      },
      status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'applied'],
        default: 'pending',
      },
      appliedAt: Date,
      appliedBy: String,
    }],
    default: [],
  })
  cvbFixes?: {
    field: string;
    issue: string;
    currentValue: any;
    suggestedValue: any;
    riskLevel: 'safe' | 'manual';
    status: 'pending' | 'approved' | 'rejected' | 'applied';
    appliedAt?: Date;
    appliedBy?: string;
  }[];
}

export type SeedingRecordDocument = SeedingRecord & Document;
export const SeedingRecordSchema =
  SchemaFactory.createForClass(SeedingRecord);

SeedingRecordSchema.index({ module: 1 });
SeedingRecordSchema.index({ status: 1 });
SeedingRecordSchema.index({ sessionId: 1, module: 1, status: 1 });
// Speeds up the Coverage page's per-city group aggregation.
SeedingRecordSchema.index({ 'transformedData.city': 1 });
