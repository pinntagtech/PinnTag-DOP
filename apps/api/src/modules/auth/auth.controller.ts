import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request as ExpressRequest } from 'express';
import { AuthService } from './auth.service';
import { DopUserRole } from './schemas/dop-user.schema';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(
    @Body() body: { email: string; password: string },
    @Req() req: ExpressRequest,
  ) {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    return this.authService.login(
      body.email,
      body.password,
      ip,
      userAgent,
    );
  }

  @Post('refresh')
  async refresh(
    @Body() body: { refreshToken: string },
    @Req() req: ExpressRequest,
  ) {
    return this.authService.refresh(
      body.refreshToken,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Post('logout')
  async logout(@Body() body: { refreshToken: string }) {
    await this.authService.logout(body.refreshToken);
    return { message: 'Logged out successfully' };
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  async me(@Request() req: any) {
    return {
      id: req.user._id.toString(),
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
      environments: req.user.environments,
      lastLoginAt: req.user.lastLoginAt,
    };
  }

  // ── User management (super_admin only) ───────────────

  @Get('users')
  @UseGuards(AuthGuard('jwt'))
  async getUsers(@Request() req: any) {
    if (req.user.role !== 'super_admin') {
      throw new ForbiddenException();
    }
    return this.authService.getUsers();
  }

  @Post('users')
  @UseGuards(AuthGuard('jwt'))
  async createUser(
    @Request() req: any,
    @Body()
    body: {
      email: string;
      password: string;
      name: string;
      role: DopUserRole;
      environments: string[];
      sendCredentials?: boolean;
    },
  ) {
    if (req.user.role !== 'super_admin') {
      throw new ForbiddenException();
    }
    return this.authService.createUser({
      ...body,
      createdBy: req.user._id.toString(),
      sendCredentials: body.sendCredentials ?? false,
    });
  }

  @Patch('users/:id')
  @UseGuards(AuthGuard('jwt'))
  async updateUser(
    @Param('id') id: string,
    @Request() req: any,
    @Body()
    body: {
      name?: string;
      role?: DopUserRole;
      environments?: string[];
      isActive?: boolean;
      password?: string;
    },
  ) {
    if (req.user.role !== 'super_admin') {
      throw new ForbiddenException();
    }
    await this.authService.updateUser(
      id,
      body,
      req.user._id.toString(),
    );
    return { message: 'User updated' };
  }

  @Delete('users/:id')
  @UseGuards(AuthGuard('jwt'))
  async deleteUser(@Param('id') id: string, @Request() req: any) {
    if (req.user.role !== 'super_admin') {
      throw new ForbiddenException();
    }
    await this.authService.deleteUser(id);
    return { message: 'User deleted' };
  }

  @Get('audit-logs')
  @UseGuards(AuthGuard('jwt'))
  async getAuditLogs(
    @Request() req: any,
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('resource') resource?: string,
    @Query('environment') environment?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const role = req.user.role;
    if (role !== 'super_admin' && role !== 'admin') {
      throw new ForbiddenException();
    }
    return this.authService.getAuditLogs({
      userId,
      action,
      resource,
      environment,
      from,
      to,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 50,
    });
  }
}
