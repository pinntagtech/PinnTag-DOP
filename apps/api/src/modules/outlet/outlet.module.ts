import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Outlet, OutletSchema } from './outlet.schema';
import { OutletRepository } from './outlet.repository';
import { OutletService } from './outlet.service';
import { OutletController } from './outlet.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Outlet.name, schema: OutletSchema },
    ]),
  ],
  controllers: [OutletController],
  providers: [OutletRepository, OutletService],
  exports: [OutletService],
})
export class OutletModule {}
