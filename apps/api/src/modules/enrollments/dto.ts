import {
  activateEnrollmentSchema,
  cancelMyEnrollmentSchema,
  createEnrollmentSchema,
  enrollmentDecisionSchema,
  listAdminEnrollmentsQuerySchema,
  listMyEnrollmentsQuerySchema,
} from '@app/shared';
import { createZodDto } from 'nestjs-zod';

export class CreateEnrollmentDto extends createZodDto(createEnrollmentSchema) {}
/** Documentation only — the cancel body may be omitted (see parseOptionalBody). */
export class CancelMyEnrollmentDto extends createZodDto(cancelMyEnrollmentSchema) {}
export class ActivateEnrollmentDto extends createZodDto(activateEnrollmentSchema) {}
export class EnrollmentDecisionDto extends createZodDto(enrollmentDecisionSchema) {}
export class ListAdminEnrollmentsQueryDto extends createZodDto(listAdminEnrollmentsQuerySchema) {}
export class ListMyEnrollmentsQueryDto extends createZodDto(listMyEnrollmentsQuerySchema) {}
