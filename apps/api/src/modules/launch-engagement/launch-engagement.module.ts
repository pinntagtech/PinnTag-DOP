import { Module } from '@nestjs/common';
import { LaunchEngagementController } from './launch-engagement.controller';
import { LaunchEngagementService } from './launch-engagement.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [LaunchEngagementController],
  providers: [LaunchEngagementService],
  exports: [LaunchEngagementService],
})
export class LaunchEngagementModule {}
