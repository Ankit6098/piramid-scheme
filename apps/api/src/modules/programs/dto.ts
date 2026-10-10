import {
  cancelProgramSchema,
  createProgramOptionSchema,
  createProgramSchema,
  listAdminProgramsQuerySchema,
  listMemberProgramsQuerySchema,
  pauseProgramSchema,
  programLifecycleSchema,
  setProgramAdminsSchema,
  updateProgramOptionSchema,
  updateProgramSchema,
} from '@app/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class CreateProgramDto extends createZodDto(createProgramSchema) {}
export class UpdateProgramDto extends createZodDto(updateProgramSchema) {}
export class ListAdminProgramsQueryDto extends createZodDto(listAdminProgramsQuerySchema) {}
export class ListMemberProgramsQueryDto extends createZodDto(listMemberProgramsQuerySchema) {}
/** Documentation only — lifecycle bodies may be omitted (see parseOptionalBody). */
export class ProgramLifecycleDto extends createZodDto(programLifecycleSchema) {}
export class PauseProgramDto extends createZodDto(pauseProgramSchema) {}
export class CancelProgramDto extends createZodDto(cancelProgramSchema) {}
export class CreateProgramOptionDto extends createZodDto(createProgramOptionSchema) {}
export class UpdateProgramOptionDto extends createZodDto(updateProgramOptionSchema) {}
export class SetProgramAdminsDto extends createZodDto(setProgramAdminsSchema) {}

/** `:id/options/:optionId` path params. */
export class ProgramOptionParamsDto extends createZodDto(z.object({ id: z.uuid(), optionId: z.uuid() })) {}
/** `GET /programs/:idOrCode` — a uuid or a program code. */
export class ProgramIdOrCodeParamDto extends createZodDto(
  z.object({ idOrCode: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/, 'Invalid program id or code') }),
) {}
