import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/**
 * Ledger HTTP routes (/api/v1/ledger). Owned by the ledger slice — HTTP only: validate with
 * createZodDto DTOs, call the service, return `ok(...)` / `paginate(...)` envelopes.
 * Admin routes for this module go in a separate controller under `admin/${d.path}`.
 */
@ApiTags('ledger')
@Controller('ledger')
export class LedgerController {}
