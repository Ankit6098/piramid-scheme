import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/**
 * Policies HTTP routes (/api/v1/policies). Owned by the policies slice — HTTP only: validate with
 * createZodDto DTOs, call the service, return `ok(...)` / `paginate(...)` envelopes.
 * Admin routes for this module go in a separate controller under `admin/${d.path}`.
 */
@ApiTags('policies')
@Controller('policies')
export class PoliciesController {}
