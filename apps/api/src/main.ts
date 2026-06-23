import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/exceptions/http-exception.filter';
import { AuthService } from './modules/auth/auth.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ extended: true, limit: '50mb' }));

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port') ?? 3000;
  const prefix = configService.get<string>('app.apiPrefix') ?? 'api/v1';

  app.setGlobalPrefix(prefix);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  app.enableCors();

  const authService = app.get(AuthService);
  await authService.bootstrapRootAdmin();

  app.use('/api/v1/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'pinntag-dop-api',
      timestamp: new Date().toISOString(),
    });
  });

  await app.listen(port);
  console.log(`PinnTag DOP API running on port ${port}`);
}

bootstrap();
