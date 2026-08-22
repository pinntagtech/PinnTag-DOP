import { IsIn, IsMongoId, IsString } from 'class-validator';
import { SeedingEnvironments } from '../../../common/constants';

const ENVIRONMENTS = Object.values(SeedingEnvironments) as string[];

export class EnrollDto {
  @IsString()
  @IsIn(ENVIRONMENTS)
  targetEnvironment: string;

  @IsMongoId()
  businessId: string;
}
