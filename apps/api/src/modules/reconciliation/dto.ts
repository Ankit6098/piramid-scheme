import { reconciliationQuerySchema } from '@app/shared';
import { createZodDto } from 'nestjs-zod';

export class ReconciliationQueryDto extends createZodDto(reconciliationQuerySchema) {}
