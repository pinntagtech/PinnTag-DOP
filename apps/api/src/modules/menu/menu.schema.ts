import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Menu {
  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String })
  description: string;

  @Prop({ type: Types.ObjectId })
  business: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'BusinessUser' })
  createdBy: Types.ObjectId;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'File' }] })
  images: Types.ObjectId[];

  @Prop({ type: String })
  type: string;
}

export type MenuDocument = Menu & Document;
export const MenuSchema = SchemaFactory.createForClass(Menu);
