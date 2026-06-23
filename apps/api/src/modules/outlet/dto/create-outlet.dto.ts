import { IsOptional, IsString } from 'class-validator';

export class CreateOutletDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  business?: string;

  @IsString()
  @IsOptional()
  address1?: string;

  @IsString()
  @IsOptional()
  city?: string;
}
