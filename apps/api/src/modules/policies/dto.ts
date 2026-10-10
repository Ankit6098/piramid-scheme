import {
  createPolicyDraftSchema,
  dryRunPolicySchema,
  listPoliciesQuerySchema,
  publishPolicySchema,
  retirePolicySchema,
  updatePolicyDraftSchema,
  validatePolicySchema,
} from '@app/shared';
import { createZodDto } from 'nestjs-zod';

export class CreatePolicyDraftDto extends createZodDto(createPolicyDraftSchema) {}
export class UpdatePolicyDraftDto extends createZodDto(updatePolicyDraftSchema) {}
export class ValidatePolicyDto extends createZodDto(validatePolicySchema) {}
export class PublishPolicyDto extends createZodDto(publishPolicySchema) {}
export class RetirePolicyDto extends createZodDto(retirePolicySchema) {}
export class DryRunPolicyDto extends createZodDto(dryRunPolicySchema) {}
export class ListPoliciesQueryDto extends createZodDto(listPoliciesQuerySchema) {}
