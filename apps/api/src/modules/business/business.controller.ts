import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { BusinessService } from './business.service';
import { CreateBusinessDto } from './dto/create-business.dto';

@Controller('businesses')
export class BusinessController {
  constructor(private readonly businessService: BusinessService) {}

  @Post()
  async create(@Body() createBusinessDto: CreateBusinessDto) {
    return this.businessService.create(createBusinessDto as any);
  }

  @Get()
  async findAll() {
    return this.businessService.findAll();
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    return this.businessService.findById(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() updateData: Partial<CreateBusinessDto>,
  ) {
    return this.businessService.update(id, updateData as any);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.businessService.delete(id);
  }
}
