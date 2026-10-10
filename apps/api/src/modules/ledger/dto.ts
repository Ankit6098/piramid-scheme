import {
  ledgerAccountListQuerySchema,
  ledgerExportQuerySchema,
  ledgerTransactionListQuerySchema,
} from '@app/shared';
import { createZodDto } from 'nestjs-zod';

export class LedgerTransactionListQueryDto extends createZodDto(ledgerTransactionListQuerySchema) {}
export class LedgerAccountListQueryDto extends createZodDto(ledgerAccountListQuerySchema) {}
export class LedgerExportQueryDto extends createZodDto(ledgerExportQuerySchema) {}
