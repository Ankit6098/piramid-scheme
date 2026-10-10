import { createZodDto } from 'nestjs-zod';
import {
  changePasswordSchema,
  confirmEmailChangeSchema,
  cursorPageQuerySchema,
  resetTotpSchema,
  startEmailChangeSchema,
  updateProfileSchema,
} from '@app/shared';

export class UpdateProfileDto extends createZodDto(updateProfileSchema) {}
export class ChangePasswordDto extends createZodDto(changePasswordSchema) {}
export class StartEmailChangeDto extends createZodDto(startEmailChangeSchema) {}
export class ConfirmEmailChangeDto extends createZodDto(confirmEmailChangeSchema) {}
export class ResetTotpDto extends createZodDto(resetTotpSchema) {}
export class PageQueryDto extends createZodDto(cursorPageQuerySchema) {}
