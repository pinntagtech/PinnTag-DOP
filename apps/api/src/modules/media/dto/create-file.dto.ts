import { IsNotEmpty, IsString, IsEnum } from 'class-validator';
import { FileType } from '../../../common/enums';

export class CreateFileDto {
  @IsString()
  @IsNotEmpty()
  @IsEnum(['Drive', 'Folder'])
  ParentDirectoryType: string;

  @IsString()
  @IsNotEmpty()
  @IsEnum(Object.values(FileType))
  fileType: string;

  @IsString()
  @IsNotEmpty()
  category: string;

  @IsString()
  @IsNotEmpty()
  @IsEnum(['User', 'Admin', 'Event', 'BusinessUser'])
  parentType: string;
}
