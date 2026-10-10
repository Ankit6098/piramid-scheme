import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { FlagKind } from '@app/shared';
import { AuditService } from '../../common/audit/audit.service';
import type { FraudRegistrationAttributedPayload } from '../../common/outbox/outbox.topics';
import { OutboxTopic } from '../../common/outbox/outbox.topics';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  OutboxHandlerRegistry,
  PermanentOutboxError,
  type OutboxMessageView,
} from '../../jobs/outbox/outbox-handler.registry';
import {
  isSharedIpSuspicious,
  SHARED_IP_WINDOW_HOURS,
  sharedIpDedupeKey,
  sharedIpFlagDetails,
} from './domain/fraud';

export interface SharedIpEvaluation {
  outcome: 'SKIPPED' | 'BELOW_THRESHOLD' | 'ALREADY_REVIEWED' | 'FLAG_RAISED' | 'FLAG_UPDATED';
  /** Attributions for (sponsor, IP) in the 24 h window ending at the evaluated attribution. */
  count: number;
  flagId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Advisory fraud heuristic SHARED_IP_REGISTRATIONS (business rules §12), driven by the outbox:
 * `ReferralsService.attachNewMember` enqueues `fraud.registration-attributed` inside the registration
 * transaction, so the worker only ever sees committed attributions (at-least-once, idempotent).
 *
 * For the attribution's (sponsor, registration IP) it counts REGISTRATION attributions in the 24 h
 * window ending at that attribution. ≥ 3 → upsert the OPEN flag on the sponsor with dedupe key
 * `SHARED_IP:<sponsorId>:<ip>` (unique while OPEN). The flag text reports the latest 24 h cluster,
 * so it only grows regardless of delivery order. An attribution older than an admin's resolution of
 * the same key is not re-raised. Flags never change balances.
 */
@Injectable()
export class FraudSignalsService {
  private readonly logger = new Logger(FraudSignalsService.name);

  constructor(
    registry: OutboxHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    registry.register(OutboxTopic.FraudRegistrationAttributed, { handle: (m) => this.handle(m) });
  }

  async handle(message: OutboxMessageView<FraudRegistrationAttributedPayload>): Promise<void> {
    const childUserId = message.payload?.childUserId;
    if (typeof childUserId !== 'string' || !UUID_RE.test(childUserId)) {
      throw new PermanentOutboxError('fraud.registration-attributed payload is invalid');
    }
    const result = await this.evaluateRegistration(childUserId);
    if (result.outcome === 'FLAG_RAISED') this.logger.log(`Raised ${FlagKind.SharedIpRegistrations} flag ${result.flagId}`);
  }

  async evaluateRegistration(childUserId: string): Promise<SharedIpEvaluation> {
    const rel = await this.prisma.referralRelationship.findUnique({
      where: { childUserId },
      select: { sponsorUserId: true, registrationIp: true, attributedAt: true, source: true },
    });
    // Corrections are admin actions, not sign-ups; no IP → nothing to correlate.
    if (!rel || rel.source !== 'REGISTRATION' || !rel.registrationIp) return { outcome: 'SKIPPED', count: 0 };
    const { sponsorUserId, attributedAt } = rel;
    const ip = rel.registrationIp;

    const [stats] = await this.prisma.$queryRaw<Array<{ triggerCount: number; latestCount: number; latestAt: Date | null }>>`
      WITH m AS (
        SELECT "attributed_at" FROM "referral_relationships"
        WHERE "sponsor_user_id" = ${sponsorUserId}::uuid AND "registration_ip" = ${ip}::inet
          AND "source" = 'REGISTRATION'
      ), latest AS (SELECT max("attributed_at") AS "at" FROM m)
      SELECT
        (SELECT count(*) FROM m
          WHERE "attributed_at" > ${attributedAt}::timestamptz - make_interval(hours => ${SHARED_IP_WINDOW_HOURS}::int)
            AND "attributed_at" <= ${attributedAt}::timestamptz)::int AS "triggerCount",
        (SELECT count(*) FROM m, latest
          WHERE m."attributed_at" > latest."at" - make_interval(hours => ${SHARED_IP_WINDOW_HOURS}::int))::int AS "latestCount",
        (SELECT "at" FROM latest) AS "latestAt"`;
    const triggerCount = stats?.triggerCount ?? 0;
    if (!isSharedIpSuspicious(triggerCount)) return { outcome: 'BELOW_THRESHOLD', count: triggerCount };

    const dedupeKey = sharedIpDedupeKey(sponsorUserId, ip);
    const reviewed = await this.prisma.memberFlag.findFirst({
      where: { dedupeKey, status: { not: 'OPEN' }, resolvedAt: { gte: attributedAt } },
      select: { id: true },
    });
    if (reviewed) return { outcome: 'ALREADY_REVIEWED', count: triggerCount, flagId: reviewed.id };

    const useLatest = isSharedIpSuspicious(stats?.latestCount ?? 0) && stats?.latestAt;
    const details = useLatest
      ? sharedIpFlagDetails(stats.latestCount, ip, stats.latestAt as Date)
      : sharedIpFlagDetails(triggerCount, ip, attributedAt);

    return this.prisma.runInTransaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ id: string; inserted: boolean }>>`
        INSERT INTO "member_flags" ("id", "user_id", "kind", "details", "status", "dedupe_key", "created_at", "updated_at")
        VALUES (${randomUUID()}::uuid, ${sponsorUserId}::uuid, ${FlagKind.SharedIpRegistrations}, ${details}, 'OPEN', ${dedupeKey}, now(), now())
        ON CONFLICT ("dedupe_key") WHERE "status" = 'OPEN' AND "dedupe_key" IS NOT NULL
        DO UPDATE SET "details" = EXCLUDED."details", "updated_at" = now()
          WHERE "member_flags"."details" IS DISTINCT FROM EXCLUDED."details"
        RETURNING "id", (xmax = 0) AS "inserted"`;
      if (!row) {
        // Conflict with identical details: nothing changed (redelivery).
        const open = await tx.memberFlag.findFirst({ where: { dedupeKey, status: 'OPEN' }, select: { id: true } });
        return { outcome: 'FLAG_UPDATED', count: triggerCount, ...(open ? { flagId: open.id } : {}) };
      }
      if (row.inserted) {
        await this.audit.record(tx, {
          action: 'flag.raise',
          resourceType: 'member_flag',
          resourceId: row.id,
          actorUserId: null,
          after: { userId: sponsorUserId, kind: FlagKind.SharedIpRegistrations, status: 'OPEN', count: triggerCount },
        });
      }
      return { outcome: row.inserted ? 'FLAG_RAISED' : 'FLAG_UPDATED', count: triggerCount, flagId: row.id };
    });
  }
}
