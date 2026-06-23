import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { BusinessUserService } from './business-user.service';
import { CreateBusinessUserDto } from './dto/create-business-user.dto';

@Controller('business-users')
export class BusinessUserController {
  constructor(private readonly businessUserService: BusinessUserService) {}

  @Post()
  async create(@Body() dto: CreateBusinessUserDto) {
    return this.businessUserService.create(dto);
  }

  @Get()
  async findAll() {
    return this.businessUserService.findAll();
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    return this.businessUserService.findById(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() data: Partial<CreateBusinessUserDto>,
  ) {
    return this.businessUserService.update(id, data);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.businessUserService.delete(id);
  }
}
