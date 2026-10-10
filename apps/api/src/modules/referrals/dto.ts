import {
  createFlagSchema,
  directReferralsQuerySchema,
  hierarchyChildrenQuerySchema,
  hierarchyMemberParamSchema,
  hierarchySearchQuerySchema,
  hierarchyTreeQuerySchema,
  listFlagsQuerySchema,
  resolveFlagSchema,
  sponsorCorrectionPreviewQuerySchema,
  sponsorCorrectionSchema,
  validateReferralCodeSchema,
} from '@app/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class ValidateReferralCodeDto extends createZodDto(validateReferralCodeSchema) {}
export class DirectReferralsQueryDto extends createZodDto(directReferralsQuerySchema) {}
export class HierarchyTreeQueryDto extends createZodDto(hierarchyTreeQuerySchema) {}
export class HierarchyChildrenQueryDto extends createZodDto(hierarchyChildrenQuerySchema) {}
export class HierarchySearchQueryDto extends createZodDto(hierarchySearchQuerySchema) {}
export class HierarchyMemberParamDto extends createZodDto(hierarchyMemberParamSchema) {}
/** `/admin/members/:id/hierarchy/path/:memberId` */
export class AdminMemberPathParamDto extends createZodDto(z.object({ id: z.uuid(), memberId: z.uuid() })) {}
export class SponsorCorrectionPreviewQueryDto extends createZodDto(sponsorCorrectionPreviewQuerySchema) {}
export class SponsorCorrectionDto extends createZodDto(sponsorCorrectionSchema) {}
export class ListFlagsQueryDto extends createZodDto(listFlagsQuerySchema) {}
export class CreateFlagDto extends createZodDto(createFlagSchema) {}
export class ResolveFlagDto extends createZodDto(resolveFlagSchema) {}
