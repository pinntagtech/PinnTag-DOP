import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { OutletService } from './outlet.service';
import { CreateOutletDto } from './dto/create-outlet.dto';

@Controller('outlets')
export class OutletController {
  constructor(private readonly outletService: OutletService) {}

  @Post()
  async create(@Body() dto: CreateOutletDto) {
    return this.outletService.create(dto as any);
  }

  @Get()
  async findAll() {
    return this.outletService.findAll();
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    return this.outletService.findById(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() data: Partial<CreateOutletDto>,
  ) {
    return this.outletService.update(id, data as any);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.outletService.delete(id);
  }
}
