import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/**
 * Admin HTTP routes (/api/v1/admin). Owned by the admin slice — HTTP only: validate with
 * createZodDto DTOs, call the service, return `ok(...)` / `paginate(...)` envelopes.
 * Everything under /api/v1/admin requires an admin role + MFA-verified session (SessionAuthGuard).
 */
@ApiTags('admin')
@Controller('admin')
export class AdminController {}
