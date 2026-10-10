// Contracts for API clients (integrations): machine credentials that submit sales for ONE program.
// Business rules §8. Keys are shown once at creation and stored only as SHA-256.
import { z } from 'zod';
import { cursorPageQuerySchema, uuidSchema } from '../api';

/** Every API key starts with this prefix (helps secret scanners and support). */
export const API_KEY_PREFIX = 'rpk_';

export const ApiClientStatus = ['ACTIVE', 'REVOKED'] as const;
export type ApiClientStatus = (typeof ApiClientStatus)[number];

/** POST /admin/integrations/clients (integrations:manage). */
export const createApiClientSchema = z.object({
  programId: uuidSchema,
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
});
export type CreateApiClientInput = z.input<typeof createApiClientSchema>;

export const listApiClientsQuerySchema = cursorPageQuerySchema.extend({
  programId: uuidSchema.optional(),
  status: z.enum(ApiClientStatus).optional(),
});
export type ListApiClientsQuery = z.input<typeof listApiClientsQuerySchema>;

/** POST /admin/integrations/clients/:id/revoke. */
export const revokeApiClientSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});
export type RevokeApiClientInput = z.input<typeof revokeApiClientSchema>;

export interface ApiClientDto {
  id: string;
  name: string;
  /** First characters of the key, for recognising it (never the key). */
  keyPrefix: string;
  status: ApiClientStatus;
  program: { id: string; code: string; name: string };
  createdBy: { id: string; fullName: string } | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Creation response: the only time the full key is ever returned. */
export interface CreatedApiClientDto {
  client: ApiClientDto;
  apiKey: string;
}
