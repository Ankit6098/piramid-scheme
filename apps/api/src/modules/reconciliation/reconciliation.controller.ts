import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import { ok } from '../../common/http/envelope';
import { ReconciliationQueryDto } from './dto';
import { ReconciliationService } from './reconciliation.service';

/** Reconciliation report (/api/v1/admin/reconciliation) — business rules §11. */
@ApiTags('reconciliation')
@Controller('admin/reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get()
  @RequirePermissions('reconciliation:read')
  async report(@CurrentUser() auth: AuthContext, @Query() q: ReconciliationQueryDto) {
    return ok(await this.reconciliation.getReport(auth, { refresh: q.refresh }));
  }
}
