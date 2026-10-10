import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { EnrollmentsModule } from './enrollments/enrollments.module';
import { EventsModule } from './events/events.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { LedgerModule } from './ledger/ledger.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OfferingsModule } from './offerings/offerings.module';
import { PoliciesModule } from './policies/policies.module';
import { ProgramsModule } from './programs/programs.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { ReferralsModule } from './referrals/referrals.module';
import { RewardsModule } from './rewards/rewards.module';
import { SettingsModule } from './settings/settings.module';
import { UsersModule } from './users/users.module';

/** Every feature module. Imported by both AppModule (HTTP) and WorkerModule (jobs). */
export const FEATURE_MODULES = [
  AuthModule,
  UsersModule,
  SettingsModule,
  OfferingsModule,
  ProgramsModule,
  EnrollmentsModule,
  ReferralsModule,
  PoliciesModule,
  EventsModule,
  IntegrationsModule,
  RewardsModule,
  LedgerModule,
  ReconciliationModule,
  NotificationsModule,
  AuditModule,
  AdminModule,
];
