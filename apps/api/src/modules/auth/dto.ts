import { createZodDto } from 'nestjs-zod';
import {
  forgotPasswordSchema,
  loginSchema,
  mfaCodeSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@app/shared';

export class RegisterDto extends createZodDto(registerSchema) {}
export class ResendVerificationDto extends createZodDto(resendVerificationSchema) {}
export class VerifyEmailDto extends createZodDto(verifyEmailSchema) {}
export class LoginDto extends createZodDto(loginSchema) {}
export class MfaCodeDto extends createZodDto(mfaCodeSchema) {}
export class ForgotPasswordDto extends createZodDto(forgotPasswordSchema) {}
export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
