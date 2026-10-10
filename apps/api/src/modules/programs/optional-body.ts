import type { z } from 'zod';

/**
 * Validates a request body that may be omitted entirely (Express 5 leaves `req.body` undefined when
 * no body is sent, which the global DTO pipe would reject). Use with an untyped `@Body() body: unknown`
 * and document the shape with `@ApiBody({ type: SomeDto, required: false })`. A raw ZodError is
 * rendered as 400 VALIDATION_FAILED by the global exception filter.
 */
export function parseOptionalBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  return schema.parse(body ?? {});
}
