import { Module } from '@nestjs/common';
import { ReferralsModule } from '../referrals/referrals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthController } from './auth.controller';

/** Registration, login, logout, email OTP (verification, admin MFA, password reset, email change), sessions. */
@Module({
  imports: [ReferralsModule, NotificationsModule],
  controllers: [AuthController],
  providers: [],
  exports: [],
})
export class AuthModule {}
