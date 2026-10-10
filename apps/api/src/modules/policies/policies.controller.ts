import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ok } from '../../common/http/envelope';
import { IdParamDto } from '../../common/validation/zod';
import { PoliciesService } from './policies.service';

/**
 * Member transparency (any signed-in user): the reward levels of a program's current policy —
 * levels, percentages / fixed amounts and the budget — without internal fields.
 */
@ApiTags('policies')
@Controller('programs')
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @Get(':id/policy')
  async current(@Param() p: IdParamDto) {
    return ok(await this.policies.memberPolicy(p.id));
  }
}
