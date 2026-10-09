/**
 * Request validation (nestjs-zod). A global `ZodValidationPipe` (APP_PIPE) validates every `@Body()`,
 * `@Query()` and `@Param()` whose TypeScript type is a nestjs-zod DTO class. Failures become
 * 400 `{ error: { code: 'VALIDATION_FAILED', details: { issues: [{ path, message, code }] } } }`.
 *
 * Define DTOs from the shared contracts (the schema lives in `@app/shared`, the class here):
 *
 *   // packages/shared/src/contracts/programs.ts
 *   export const createProgramSchema = z.object({ name: z.string().min(1), ... });
 *
 *   // apps/api/src/modules/programs/dto.ts
 *   import { createZodDto } from 'nestjs-zod';
 *   import { createProgramSchema, cursorPageQuerySchema } from '@app/shared';
 *   export class CreateProgramDto extends createZodDto(createProgramSchema) {}
 *   export class ListProgramsQueryDto extends createZodDto(cursorPageQuerySchema) {}
 *
 *   // controller
 *   @Post() create(@Body() body: CreateProgramDto) { ... }        // body is the parsed output
 *   @Get()  list(@Query() q: ListProgramsQueryDto) { ... }        // z.coerce for numbers in queries
 *
 * Path params: use a DTO (`class IdParamDto extends createZodDto(z.object({ id: z.uuid() })) {}` with
 * `@Param() p: IdParamDto`) or `@Param('id', new ZodValidationPipe(z.uuid()))`.
 * A value whose type is not a DTO is passed through unvalidated — always use a DTO for input.
 */
export { createZodDto, ZodValidationPipe } from 'nestjs-zod';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/** `:id` path param DTO (uuid). */
export class IdParamDto extends createZodDto(z.object({ id: z.uuid() })) {}
