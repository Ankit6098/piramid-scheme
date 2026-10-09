import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/**
 * Reconciliation HTTP routes (/api/v1/reconciliation). Owned by the reconciliation slice — HTTP only: validate with
 * createZodDto DTOs, call the service, return `ok(...)` / `paginate(...)` envelopes.
 * Admin routes for this module go in a separate controller under `admin/${d.path}`.
 */
@ApiTags('reconciliation')
@Controller('reconciliation')
export class ReconciliationController {}
