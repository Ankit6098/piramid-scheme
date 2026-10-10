import { createApiClientSchema, listApiClientsQuerySchema, revokeApiClientSchema } from '@app/shared';
import { createZodDto } from 'nestjs-zod';

export class CreateApiClientDto extends createZodDto(createApiClientSchema) {}
export class ListApiClientsQueryDto extends createZodDto(listApiClientsQuerySchema) {}
export class RevokeApiClientDto extends createZodDto(revokeApiClientSchema) {}
