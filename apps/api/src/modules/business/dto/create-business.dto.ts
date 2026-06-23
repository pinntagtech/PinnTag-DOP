import { IsNotEmpty, IsString, IsNumber, IsEnum, IsOptional } from 'class-validator';
import { BusinessCreatorType, BusinessStatus } from '../../../common/enums';

export class CreateBusinessDto {
  @IsNumber()
  @IsOptional()
  @IsEnum(Object.values(BusinessStatus))
  status?: number;

  @IsString()
  @IsNotEmpty()
  @IsEnum(Object.values(BusinessCreatorType))
  creatorType: string;

  @IsString()
  @IsNotEmpty()
  creator: string;

  @IsString()
  @IsOptional()
  name?: string;
}
