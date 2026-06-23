import {
  Controller,
  Get,
  Param,
  Headers,
  HttpException,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { basename } from 'path';
import { Public } from '../../auth/decorators/public.decorator';
import { BotSourceService } from './bot-source.service';

@Controller('seeding/bot/source')
export class BotSourceController {
  constructor(
    private readonly botSourceService: BotSourceService,
    private readonly configService: ConfigService,
  ) {}

  private assertSecret(secret?: string) {
    const expected = this.configService.get<string>('app.botWebhookSecret');
    if (!expected || secret !== expected) {
      throw new HttpException('Unauthorized', 401);
    }
  }

  @Public()
  @Get('manifest')
  async getManifest(@Headers('x-bot-secret') secret?: string) {
    this.assertSecret(secret);
    return this.botSourceService.getManifest();
  }

  @Public()
  @Get('file/:name')
  async getFile(
    @Param('name') name: string,
    @Res() res: Response,
    @Headers('x-bot-secret') secret?: string,
  ) {
    this.assertSecret(secret);

    // Defense in depth: basename strips any path traversal attempt
    // (e.g. ../../etc/passwd or bot-source/main.py) before whitelist check.
    const safeName = basename(name || '');
    if (!this.botSourceService.isWhitelisted(safeName)) {
      throw new HttpException('Not found', 404);
    }

    const obj = await this.botSourceService.getFile(safeName);
    res.setHeader('Content-Type', obj.contentType);
    res.setHeader('Content-Length', obj.body.length.toString());
    res.setHeader('Cache-Control', 'no-cache');
    res.end(obj.body);
  }
}
