import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { MenuService } from './menu.service';
import { CreateMenuDto } from './dto/create-menu.dto';

@Controller('menus')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Post()
  async create(@Body() dto: CreateMenuDto) {
    return this.menuService.create(dto);
  }

  @Get()
  async findAll() {
    return this.menuService.findAll();
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    return this.menuService.findById(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() data: Partial<CreateMenuDto>,
  ) {
    return this.menuService.update(id, data);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.menuService.delete(id);
  }
}
