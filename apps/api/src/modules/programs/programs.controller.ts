import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/**
 * Programs HTTP routes (/api/v1/programs). Owned by the programs slice — HTTP only: validate with
 * createZodDto DTOs, call the service, return `ok(...)` / `paginate(...)` envelopes.
 * Admin routes for this module go in a separate controller under `admin/${d.path}`.
 */
@ApiTags('programs')
@Controller('programs')
export class ProgramsController {}
