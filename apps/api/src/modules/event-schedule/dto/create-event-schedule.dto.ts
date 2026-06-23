import { IsNotEmpty, IsString, IsOptional, IsDateString } from 'class-validator';

export class CreateEventScheduleDto {
  @IsString()
  @IsNotEmpty()
  event: string;

  @IsDateString()
  @IsOptional()
  date?: string;

  @IsDateString()
  @IsOptional()
  startTime?: string;

  @IsDateString()
  @IsOptional()
  endTime?: string;
}
