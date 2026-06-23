import { IsOptional, IsString } from 'class-validator';

export class PublishSessionDto {
  @IsOptional()
  @IsString()
  actor?: string;
}
