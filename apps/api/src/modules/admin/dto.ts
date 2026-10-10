import { adminMemberListQuerySchema, adminMemberRolesUpdateSchema, adminMemberStatusChangeSchema } from '@app/shared';
import { createZodDto } from 'nestjs-zod';

export class AdminMemberListQueryDto extends createZodDto(adminMemberListQuerySchema) {}
export class AdminMemberStatusChangeDto extends createZodDto(adminMemberStatusChangeSchema) {}
export class AdminMemberRolesUpdateDto extends createZodDto(adminMemberRolesUpdateSchema) {}
