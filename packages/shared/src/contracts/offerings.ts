// Contracts (Zod request schemas + response types) for the offerings module.
// An Offering is an approved product or service; rewards can only come from its sales
// (docs/business-rules.md §0, §4).
import { z } from 'zod';
import { cursorPageQuerySchema, reasonSchema } from '../api';
import { OfferingKind, OfferingStatus } from '../enums';
import type { CatalogUserRef } from './settings';

// ─── Responses ──────────────────────────────────────────────────────────────

export interface OfferingDto {
  id: string;
  name: string;
  description: string | null;
  kind: OfferingKind;
  sku: string | null;
  /** New offerings are INACTIVE until a SUPER_ADMIN (`offerings:approve`) approves them. */
  status: OfferingStatus;
  approvedAt: string | null;
  approvedBy: CatalogUserRef | null;
  createdBy: CatalogUserRef | null;
  createdAt: string;
  updatedAt: string;
  /** Programs (any status) that reference this offering. */
  programCount: number;
  /** Programs that are SCHEDULED, ACTIVE or PAUSED. */
  liveProgramCount: number;
}

// ─── Requests ───────────────────────────────────────────────────────────────

export const offeringSkuSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Use up to 64 letters, digits, dots, dashes or underscores');

const offeringFields = {
  name: z.string().trim().min(2, 'Enter at least 2 characters').max(160),
  description: z.string().trim().max(2000).nullish(),
  kind: z.enum(OfferingKind),
  sku: z.union([offeringSkuSchema, z.literal('')]).nullish(),
};

/** `POST /admin/offerings` (created INACTIVE). Empty strings for description/sku mean "none". */
export const createOfferingSchema = z.object(offeringFields);
export type CreateOfferingInput = z.infer<typeof createOfferingSchema>;

/** `PATCH /admin/offerings/:id`. Editing an approved offering also requires `offerings:approve`. */
export const updateOfferingSchema = z
  .object({
    name: offeringFields.name.optional(),
    description: offeringFields.description,
    kind: offeringFields.kind.optional(),
    sku: offeringFields.sku,
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Change at least one field' });
export type UpdateOfferingInput = z.infer<typeof updateOfferingSchema>;

/** `GET /admin/offerings` — newest first (`createdAt desc, id desc`). */
export const listOfferingsQuerySchema = cursorPageQuerySchema.extend({
  status: z.enum(OfferingStatus).optional(),
  kind: z.enum(OfferingKind).optional(),
  /** Case-insensitive match on name or SKU. */
  q: z.string().trim().max(100).optional(),
});
export type ListOfferingsQuery = z.infer<typeof listOfferingsQuerySchema>;

/** `POST /admin/offerings/:id/approve` (reason optional). */
export const approveOfferingSchema = z.object({ reason: reasonSchema.optional() });
export type ApproveOfferingInput = z.infer<typeof approveOfferingSchema>;

/** `POST /admin/offerings/:id/deactivate` — live programs can no longer record its sales. */
export const deactivateOfferingSchema = z.object({ reason: reasonSchema });
export type DeactivateOfferingInput = z.infer<typeof deactivateOfferingSchema>;
