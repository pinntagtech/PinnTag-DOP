import { IsOptional, IsString } from 'class-validator';

export class AreaDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  subRegion?: string;

  @IsOptional()
  @IsString()
  state?: string;
}
