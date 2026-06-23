import { IsArray, IsIn, IsString, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import { SeedingModules } from '../../../common/constants';

export class BulkUploadRecordsDto {
  @IsString()
  @IsIn(Object.values(SeedingModules))
  module: string;

  @IsArray()
  @ArrayMinSize(1)
  @Type(() => Object)
  records: Record<string, any>[];
}
