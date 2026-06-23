import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BusinessUser, BusinessUserSchema } from './business-user.schema';
import { BusinessUserRepository } from './business-user.repository';
import { BusinessUserService } from './business-user.service';
import { BusinessUserController } from './business-user.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BusinessUser.name, schema: BusinessUserSchema },
    ]),
  ],
  controllers: [BusinessUserController],
  providers: [BusinessUserRepository, BusinessUserService],
  exports: [BusinessUserService],
})
export class BusinessUserModule {}
