import {
  adminRewardCountsQuerySchema,
  adminRewardExportQuerySchema,
  adminRewardListQuerySchema,
  bulkApproveRewardsSchema,
  eventReversalSchema,
  memberRewardFiltersSchema,
  memberRewardListQuerySchema,
  rejectRewardSchema,
  reverseRewardSchema,
} from '@app/shared';
import { createZodDto } from 'nestjs-zod';

export class AdminRewardListQueryDto extends createZodDto(adminRewardListQuerySchema) {}
export class AdminRewardCountsQueryDto extends createZodDto(adminRewardCountsQuerySchema) {}
export class AdminRewardExportQueryDto extends createZodDto(adminRewardExportQuerySchema) {}
export class RejectRewardDto extends createZodDto(rejectRewardSchema) {}
export class ReverseRewardDto extends createZodDto(reverseRewardSchema) {}
export class BulkApproveRewardsDto extends createZodDto(bulkApproveRewardsSchema) {}
export class EventReversalDto extends createZodDto(eventReversalSchema) {}
export class MemberRewardListQueryDto extends createZodDto(memberRewardListQuerySchema) {}
export class MemberRewardFiltersDto extends createZodDto(memberRewardFiltersSchema) {}
