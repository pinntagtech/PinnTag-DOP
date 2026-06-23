import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { MediaService } from './media.service';
import { CreateFileDto } from './dto/create-file.dto';
import { CreateImageDto } from './dto/create-image.dto';
import { CreateDriveDto } from './dto/create-drive.dto';

@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  // File endpoints
  @Post('files')
  async createFile(@Body() dto: CreateFileDto) {
    return this.mediaService.createFile(dto as any);
  }

  @Get('files')
  async findFiles() {
    return this.mediaService.findFiles();
  }

  @Get('files/:id')
  async findFileById(@Param('id') id: string) {
    return this.mediaService.findFileById(id);
  }

  @Put('files/:id')
  async updateFile(
    @Param('id') id: string,
    @Body() data: Partial<CreateFileDto>,
  ) {
    return this.mediaService.updateFile(id, data as any);
  }

  @Delete('files/:id')
  async deleteFile(@Param('id') id: string) {
    return this.mediaService.deleteFile(id);
  }

  // Image endpoints
  @Post('images')
  async createImage(@Body() dto: CreateImageDto) {
    return this.mediaService.createImage(dto);
  }

  @Get('images')
  async findImages() {
    return this.mediaService.findImages();
  }

  @Get('images/:id')
  async findImageById(@Param('id') id: string) {
    return this.mediaService.findImageById(id);
  }

  @Put('images/:id')
  async updateImage(
    @Param('id') id: string,
    @Body() data: Partial<CreateImageDto>,
  ) {
    return this.mediaService.updateImage(id, data);
  }

  @Delete('images/:id')
  async deleteImage(@Param('id') id: string) {
    return this.mediaService.deleteImage(id);
  }

  // Drive endpoints
  @Post('drives')
  async createDrive(@Body() dto: CreateDriveDto) {
    return this.mediaService.createDrive(dto as any);
  }

  @Get('drives')
  async findDrives() {
    return this.mediaService.findDrives();
  }

  @Get('drives/:id')
  async findDriveById(@Param('id') id: string) {
    return this.mediaService.findDriveById(id);
  }

  @Put('drives/:id')
  async updateDrive(
    @Param('id') id: string,
    @Body() data: Partial<CreateDriveDto>,
  ) {
    return this.mediaService.updateDrive(id, data as any);
  }

  @Delete('drives/:id')
  async deleteDrive(@Param('id') id: string) {
    return this.mediaService.deleteDrive(id);
  }
}
