import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import mongoose, { Model } from 'mongoose';
import {
  DopUser,
  DopUserDocument,
  DopUserRole,
} from './schemas/dop-user.schema';
import {
  RefreshToken,
  RefreshTokenDocument,
} from './schemas/refresh-token.schema';
import {
  AuditLog,
  AuditLogDocument,
} from './schemas/audit-log.schema';
import { DopMailService } from './dop-mail.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(DopUser.name)
    private readonly userModel: Model<DopUserDocument>,
    @InjectModel(RefreshToken.name)
    private readonly refreshTokenModel: Model<RefreshTokenDocument>,
    @InjectModel(AuditLog.name)
    private readonly auditLogModel: Model<AuditLogDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly dopMailService: DopMailService,
  ) {}

  // ── Bootstrap root admin ─────────────────────────────

  async bootstrapRootAdmin(): Promise<void> {
    const email = this.configService.get<string>('app.rootAdminEmail');
    const password = this.configService.get<string>(
      'app.rootAdminPassword',
    );
    const name = this.configService.get<string>('app.rootAdminName');

    if (!email || !password) {
      this.logger.warn('Root admin credentials not set in env');
      return;
    }

    const existing = await this.userModel.findOne({
      email: email.toLowerCase(),
    });

    if (existing) {
      this.logger.log(`Root admin already exists: ${email}`);
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await this.userModel.create({
      email: email.toLowerCase(),
      passwordHash,
      name,
      role: DopUserRole.SUPER_ADMIN,
      environments: ['dev', 'pre-prod', 'staging', 'production'],
      isActive: true,
      isRootAdmin: true,
    });

    this.logger.log(`✅ Root admin created: ${email}`);
  }

  // ── Login ────────────────────────────────────────────

  async login(
    email: string,
    password: string,
    ip?: string,
    userAgent?: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: {
      id: string;
      email: string;
      name: string;
      role: string;
      environments: string[];
    };
  }> {
    const user = await this.userModel.findOne({
      email: email.toLowerCase(),
    });

    if (!user || !user.isActive) {
      await this.logAudit({
        userEmail: email,
        userName: 'Unknown',
        action: 'auth.login.failed',
        resource: 'auth',
        details: { reason: 'user not found or inactive' },
        ip,
        userAgent,
        outcome: 'failure',
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordValid = await bcrypt.compare(
      password,
      user.passwordHash,
    );

    if (!passwordValid) {
      await this.logAudit({
        userId: user._id,
        userEmail: user.email,
        userName: user.name,
        action: 'auth.login.failed',
        resource: 'auth',
        details: { reason: 'invalid password' },
        ip,
        userAgent,
        outcome: 'failure',
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    // Generate tokens
    const accessToken = this.generateAccessToken(user);
    const refreshToken = await this.generateRefreshToken(
      user,
      ip,
      userAgent,
    );

    // Update last login
    await this.userModel.updateOne(
      { _id: user._id },
      { $set: { lastLoginAt: new Date() } },
    );

    await this.logAudit({
      userId: user._id,
      userEmail: user.email,
      userName: user.name,
      action: 'auth.login.success',
      resource: 'auth',
      details: {},
      ip,
      userAgent,
      outcome: 'success',
    });

    this.logger.log(`[AUTH] Login: ${user.email}`);

    return {
      accessToken,
      refreshToken,
      user: {
        id: (user._id as mongoose.Types.ObjectId).toString(),
        email: user.email,
        name: user.name,
        role: user.role,
        environments: user.environments,
      },
    };
  }

  // ── Refresh token ────────────────────────────────────

  async refresh(
    refreshToken: string,
    ip?: string,
    userAgent?: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const tokens = await this.refreshTokenModel.find({
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });

    let matchedToken: RefreshTokenDocument | null = null;
    for (const t of tokens) {
      const match = await bcrypt.compare(refreshToken, t.tokenHash);
      if (match) {
        matchedToken = t;
        break;
      }
    }

    if (!matchedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.userModel.findById(matchedToken.userId);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found');
    }

    await this.refreshTokenModel.updateOne(
      { _id: matchedToken._id },
      { $set: { revokedAt: new Date() } },
    );

    const newAccessToken = this.generateAccessToken(user);
    const newRefreshToken = await this.generateRefreshToken(
      user,
      ip,
      userAgent,
    );

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  // ── Logout ───────────────────────────────────────────

  async logout(refreshToken: string): Promise<void> {
    const tokens = await this.refreshTokenModel.find({
      revokedAt: null,
    });

    for (const t of tokens) {
      const match = await bcrypt.compare(refreshToken, t.tokenHash);
      if (match) {
        await this.refreshTokenModel.updateOne(
          { _id: t._id },
          { $set: { revokedAt: new Date() } },
        );
        break;
      }
    }
  }

  // ── User management ──────────────────────────────────

  async createUser(payload: {
    email: string;
    password: string;
    name: string;
    role: DopUserRole;
    environments: string[];
    createdBy: string;
    sendCredentials?: boolean;
  }): Promise<DopUserDocument> {
    const existing = await this.userModel.findOne({
      email: payload.email.toLowerCase(),
    });

    if (existing) {
      throw new ConflictException('Email already exists');
    }

    const passwordHash = await bcrypt.hash(payload.password, 12);

    const user = await this.userModel.create({
      email: payload.email.toLowerCase(),
      passwordHash,
      name: payload.name,
      role: payload.role,
      environments: payload.environments,
      isActive: true,
      isRootAdmin: false,
      createdBy: new mongoose.Types.ObjectId(payload.createdBy),
    });

    if (payload.sendCredentials) {
      await this.dopMailService.sendWelcomeEmail({
        name: payload.name,
        email: payload.email,
        password: payload.password,
        role: payload.role,
        environments: payload.environments,
      });
    }

    return user;
  }

  async getUsers(): Promise<DopUserDocument[]> {
    return this.userModel
      .find({})
      .select('-passwordHash')
      .sort({ createdAt: -1 })
      .lean() as any;
  }

  async updateUser(
    id: string,
    update: Partial<{
      name: string;
      role: DopUserRole;
      environments: string[];
      isActive: boolean;
      password: string;
    }>,
    actorId: string,
  ): Promise<void> {
    const user = await this.userModel.findById(id);
    if (!user) throw new NotFoundException('User not found');

    if (user.isRootAdmin) {
      if (update.role || update.isActive === false) {
        throw new ForbiddenException('Cannot modify root admin');
      }
    }

    const setObj: Record<string, any> = {};
    if (update.name) setObj.name = update.name;
    if (update.role) setObj.role = update.role;
    if (update.environments) setObj.environments = update.environments;
    if (update.isActive !== undefined) setObj.isActive = update.isActive;
    if (update.password) {
      setObj.passwordHash = await bcrypt.hash(update.password, 12);
    }

    await this.userModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: setObj },
    );
  }

  async deleteUser(id: string): Promise<void> {
    const user = await this.userModel.findById(id);
    if (!user) throw new NotFoundException('User not found');
    if (user.isRootAdmin) {
      throw new ForbiddenException('Cannot delete root admin');
    }
    await this.userModel.deleteOne({ _id: user._id });
    await this.refreshTokenModel.updateMany(
      { userId: user._id, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
  }

  // ── Audit log ────────────────────────────────────────

  async logAudit(entry: {
    userId?: any;
    userEmail: string;
    userName: string;
    action: string;
    resource: string;
    resourceId?: string;
    details?: Record<string, any>;
    environment?: string;
    ip?: string;
    userAgent?: string;
    outcome?: string;
  }): Promise<void> {
    try {
      await this.auditLogModel.create({
        userId: entry.userId,
        userEmail: entry.userEmail,
        userName: entry.userName,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId,
        details: entry.details || {},
        environment: entry.environment,
        ip: entry.ip,
        userAgent: entry.userAgent,
        outcome: entry.outcome || 'success',
      });
    } catch (e: any) {
      this.logger.error(`Audit log failed: ${e.message}`);
    }
  }

  async getAuditLogs(filters: {
    userId?: string;
    action?: string;
    resource?: string;
    environment?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    logs: any[];
    total: number;
    page: number;
    pages: number;
  }> {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 50, 200);
    const skip = (page - 1) * limit;

    const query: Record<string, any> = {};
    if (filters.userId) {
      query.userId = new mongoose.Types.ObjectId(filters.userId);
    }
    if (filters.action) {
      query.action = new RegExp(filters.action, 'i');
    }
    if (filters.resource) {
      query.resource = filters.resource;
    }
    if (filters.environment) {
      query.environment = filters.environment;
    }
    if (filters.from || filters.to) {
      query.createdAt = {};
      if (filters.from) {
        query.createdAt.$gte = new Date(filters.from);
      }
      if (filters.to) {
        query.createdAt.$lte = new Date(filters.to);
      }
    }

    const [logs, total] = await Promise.all([
      this.auditLogModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.auditLogModel.countDocuments(query),
    ]);

    return {
      logs,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  }

  // ── JWT helpers ──────────────────────────────────────

  private generateAccessToken(user: DopUserDocument): string {
    return this.jwtService.sign(
      {
        sub: (user._id as mongoose.Types.ObjectId).toString(),
        email: user.email,
        name: user.name,
        role: user.role,
        environments: user.environments,
      },
      {
        secret: this.configService.get<string>('app.jwtAccessSecret'),
        expiresIn: this.configService.get<string>(
          'app.jwtAccessExpiresIn',
        ) as any,
      },
    );
  }

  private async generateRefreshToken(
    user: DopUserDocument,
    ip?: string,
    userAgent?: string,
  ): Promise<string> {
    const token = randomBytes(64).toString('hex');
    const tokenHash = await bcrypt.hash(token, 10);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.refreshTokenModel.create({
      userId: user._id,
      tokenHash,
      expiresAt,
      ip,
      userAgent,
    });

    return token;
  }

  // ── Validate token payload ───────────────────────────

  async validateUserById(
    id: string,
  ): Promise<DopUserDocument | null> {
    return this.userModel
      .findById(id)
      .select('-passwordHash')
      .lean() as any;
  }
}
