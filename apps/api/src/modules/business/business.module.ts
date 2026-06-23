import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Business, BusinessSchema } from './business.schema';
import { BusinessRepository } from './business.repository';
import { BusinessService } from './business.service';
import { BusinessController } from './business.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Business.name, schema: BusinessSchema },
    ]),
  ],
  controllers: [BusinessController],
  providers: [BusinessRepository, BusinessService],
  exports: [BusinessService],
})
export class BusinessModule {}
