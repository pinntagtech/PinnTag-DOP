import {
  IsString,
  MinLength,
  IsOptional,
  IsIn,
  IsArray,
} from 'class-validator';
import {
  SeedingEnvironments,
  SeedingSessionType,
} from '../../../common/constants';

export class CreateSeedingSessionDto {
  @IsString()
  @MinLength(3)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  createdBy?: string;

  @IsIn(Object.values(SeedingEnvironments))
  environment: string;

  @IsOptional()
  @IsArray()
  modules?: string[];

  @IsOptional()
  @IsIn(Object.values(SeedingSessionType))
  type?: string;
}
