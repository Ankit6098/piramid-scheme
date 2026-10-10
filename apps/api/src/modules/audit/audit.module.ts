import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit-query.service';

/** Audit log browsing for admins (writing is AuditService in common/). */
@Module({
  imports: [],
  controllers: [AuditController],
  providers: [AuditQueryService],
  exports: [AuditQueryService],
})
export class AuditModule {}
