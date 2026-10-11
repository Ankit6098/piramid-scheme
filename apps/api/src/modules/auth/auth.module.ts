import { Module } from '@nestjs/common';
import { ReferralsModule } from '../referrals/referrals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthController } from './auth.controller';
import { AuthJobs } from './auth.jobs';
import { AuthService } from './auth.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { OtpService } from './otp.service';
import { PasswordService } from './password.service';
import { SecurityNoticesService } from './security-notices.service';
import { TotpLockoutService } from './totp-lockout.service';

/** Registration, login, logout, email OTP (verification, admin MFA, password reset, email change), sessions. */
@Module({
  imports: [ReferralsModule, NotificationsModule],
  controllers: [AuthController, MfaController],
  providers: [AuthService, MfaService, OtpService, PasswordService, SecurityNoticesService, TotpLockoutService, AuthJobs],
  exports: [AuthService, MfaService, OtpService, PasswordService, SecurityNoticesService],
})
export class AuthModule {}
