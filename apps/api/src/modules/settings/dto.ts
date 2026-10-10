import { updatePlatformSettingsSchema } from '@app/shared';
import { createZodDto } from 'nestjs-zod';

export class UpdatePlatformSettingsDto extends createZodDto(updatePlatformSettingsSchema) {}
