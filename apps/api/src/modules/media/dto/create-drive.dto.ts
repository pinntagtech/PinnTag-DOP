import { IsNotEmpty, IsString, IsEnum } from 'class-validator';

export class CreateDriveDto {
  @IsString()
  @IsNotEmpty()
  owner: string;

  @IsString()
  @IsNotEmpty()
  @IsEnum(['User', 'BusinessUser', 'Admin', 'Business'])
  ownerType: string;
}
