import { IsNotEmpty, IsString, IsEnum, IsOptional } from 'class-validator';
import { BusinessUserCreatorType } from '../../../common/enums';

export class CreateBusinessUserDto {
  @IsString()
  @IsNotEmpty()
  @IsEnum(Object.values(BusinessUserCreatorType))
  creatorType: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  phone?: string;
}
