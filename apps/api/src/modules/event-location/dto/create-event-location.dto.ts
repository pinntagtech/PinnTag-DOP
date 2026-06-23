import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class CreateEventLocationDto {
  @IsString()
  @IsNotEmpty()
  event: string;

  @IsString()
  @IsOptional()
  address1?: string;

  @IsString()
  @IsOptional()
  city?: string;
}
