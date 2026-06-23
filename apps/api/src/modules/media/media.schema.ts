import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { FileType } from '../../common/enums';

@Schema({ _id: false })
export class MetaData {
  @Prop({ type: Object })
  data: any;
}
export const MetaDataSchema = SchemaFactory.createForClass(MetaData);

@Schema({ timestamps: true })
export class File {
  @Prop({ type: Types.ObjectId, refPath: 'ParentDirectoryType' })
  parentDirectory: Types.ObjectId;

  @Prop({ type: String, required: true, enum: ['Drive', 'Folder'] })
  ParentDirectoryType: string;

  @Prop({ type: MetaDataSchema })
  metaData: MetaData;

  @Prop({ type: String, required: true, enum: Object.values(FileType) })
  fileType: string;

  @Prop({ type: Types.ObjectId, required: true, ref: 'FileCategory' })
  category: Types.ObjectId;

  @Prop({ type: Types.ObjectId, refPath: 'parentType' })
  parent: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: ['User', 'Admin', 'Event', 'BusinessUser'],
  })
  parentType: string;

  @Prop({ type: String, default: 'file' })
  entity: string;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;
}

export type FileDocument = File & Document;
export const FileSchema = SchemaFactory.createForClass(File);

@Schema({ timestamps: true })
export class Image {
  @Prop({ type: Types.ObjectId })
  gallery: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  event: Types.ObjectId;

  @Prop({ type: String, required: true })
  url: string;

  @Prop({ type: Boolean })
  isCoverImage: boolean;
}

export type ImageDocument = Image & Document;
export const ImageSchema = SchemaFactory.createForClass(Image);

@Schema({ timestamps: true })
export class Drive {
  @Prop({ type: Types.ObjectId, required: true, refPath: 'ownerType' })
  owner: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: ['User', 'BusinessUser', 'Admin', 'Business'],
  })
  ownerType: string;

  @Prop({ type: Number })
  AvailableSpace: number;

  @Prop({ type: Number })
  TotalSpace: number;
}

export type DriveDocument = Drive & Document;
export const DriveSchema = SchemaFactory.createForClass(Drive);

@Schema({ timestamps: true })
export class Folder {
  @Prop({ type: String, required: true })
  folderName: string;

  @Prop({ type: Types.ObjectId })
  parentDirectory: Types.ObjectId;

  @Prop({ type: String, enum: ['Drive', 'Folder'] })
  parentType: string;

  @Prop({ type: Types.ObjectId, required: true })
  drive: Types.ObjectId;

  @Prop({ type: Types.ObjectId, refPath: 'ownerType' })
  owner: Types.ObjectId;

  @Prop({ type: String, enum: ['User', 'BusinessUser', 'Admin', 'Business'] })
  ownerType: string;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;
}

export type FolderDocument = Folder & Document;
export const FolderSchema = SchemaFactory.createForClass(Folder);
