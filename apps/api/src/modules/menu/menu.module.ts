import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Menu, MenuSchema } from './menu.schema';
import { MenuRepository } from './menu.repository';
import { MenuService } from './menu.service';
import { MenuController } from './menu.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Menu.name, schema: MenuSchema },
    ]),
  ],
  controllers: [MenuController],
  providers: [MenuRepository, MenuService],
  exports: [MenuService],
})
export class MenuModule {}
