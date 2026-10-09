import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';

/** Audit log browsing for admins (writing is AuditService in common/). */
@Module({
  imports: [],
  controllers: [AuditController],
  providers: [],
  exports: [],
})
export class AuditModule {}
