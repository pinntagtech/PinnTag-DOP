import { IsNotEmpty, IsString, IsEnum, IsOptional } from 'class-validator';
import { EventTypes } from '../../../common/enums';

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  @IsEnum(Object.values(EventTypes))
  type: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;
}
