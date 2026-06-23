import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AreaDto } from './area.dto';

export class CreateLocationDto {
  @IsString()
  city: string;

  @IsString()
  state: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AreaDto)
  areas?: AreaDto[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
