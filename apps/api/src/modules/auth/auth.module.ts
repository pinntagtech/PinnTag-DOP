import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DopMailService } from './dop-mail.service';
import { EnvGuard } from './guards/env.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { AuditInterceptor } from './interceptors/audit.interceptor';
import {
  AuditLog,
  AuditLogSchema,
} from './schemas/audit-log.schema';
import {
  DopUser,
  DopUserSchema,
} from './schemas/dop-user.schema';
import {
  RefreshToken,
  RefreshTokenSchema,
} from './schemas/refresh-token.schema';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DopUser.name, schema: DopUserSchema },
      { name: RefreshToken.name, schema: RefreshTokenSchema },
      { name: AuditLog.name, schema: AuditLogSchema },
    ]),
    JwtModule.register({}),
    PassportModule,
  ],
  providers: [
    AuthService,
    DopMailService,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    EnvGuard,
    AuditInterceptor,
    Reflector,
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
  ],
  exports: [
    AuthService,
    DopMailService,
    JwtModule,
    MongooseModule,
    JwtAuthGuard,
    RolesGuard,
    EnvGuard,
    AuditInterceptor,
    Reflector,
  ],
  controllers: [AuthController],
})
export class AuthModule {}
