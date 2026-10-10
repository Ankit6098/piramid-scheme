import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import { ok } from '../../common/http/envelope';
import { IdParamDto } from '../../common/validation/zod';
import { csvFilename } from './domain/csv';
import { streamCsv } from './csv-response';
import { LedgerAccountListQueryDto, LedgerExportQueryDto, LedgerTransactionListQueryDto } from './dto';
import { LedgerQueryService } from './ledger-query.service';

/**
 * Ledger read routes (/api/v1/admin/ledger). The ledger records reward liabilities only (no
 * payouts). Admin area: admin role + TOTP-verified session enforced by SessionAuthGuard.
 */
@ApiTags('ledger')
@Controller('admin/ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerQueryService) {}

  @Get('summary')
  @RequirePermissions('ledger:read')
  async summary(@CurrentUser() auth: AuthContext) {
    return ok(await this.ledger.summary(auth));
  }

  @Get('transactions')
  @RequirePermissions('ledger:read')
  listTransactions(@CurrentUser() auth: AuthContext, @Query() q: LedgerTransactionListQueryDto) {
    return this.ledger.listTransactions(auth, q);
  }

  @Get('transactions/:id')
  @RequirePermissions('ledger:read')
  async getTransaction(@CurrentUser() auth: AuthContext, @Param() p: IdParamDto) {
    return ok(await this.ledger.getTransaction(auth, p.id));
  }

  @Get('accounts')
  @RequirePermissions('ledger:read')
  listAccounts(@CurrentUser() auth: AuthContext, @Query() q: LedgerAccountListQueryDto) {
    return this.ledger.listAccounts(auth, q);
  }

  /** One row per ledger entry; CSV-injection safe; audited. */
  @Get('export.csv')
  @RequirePermissions('reports:export', 'ledger:read')
  async exportCsv(@CurrentUser() auth: AuthContext, @Query() q: LedgerExportQueryDto, @Res() res: Response) {
    await this.ledger.beginExport(auth, q);
    await streamCsv(res, csvFilename('ledger-entries'), (sink) => this.ledger.exportCsv(auth, q, sink));
  }
}
