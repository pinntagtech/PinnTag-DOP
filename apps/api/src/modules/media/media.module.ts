import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  File,
  FileSchema,
  Image,
  ImageSchema,
  Drive,
  DriveSchema,
  Folder,
  FolderSchema,
} from './media.schema';
import { MediaRepository } from './media.repository';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: File.name, schema: FileSchema },
      { name: Image.name, schema: ImageSchema },
      { name: Drive.name, schema: DriveSchema },
      { name: Folder.name, schema: FolderSchema },
    ]),
  ],
  controllers: [MediaController],
  providers: [MediaRepository, MediaService],
  exports: [MediaService],
})
export class MediaModule {}
