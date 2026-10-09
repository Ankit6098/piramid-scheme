import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/**
 * Users HTTP routes (/api/v1/users). Owned by the users slice — HTTP only: validate with
 * createZodDto DTOs, call the service, return `ok(...)` / `paginate(...)` envelopes.
 * Admin routes for this module go in a separate controller under `admin/${d.path}`.
 */
@ApiTags('users')
@Controller('users')
export class UsersController {}
