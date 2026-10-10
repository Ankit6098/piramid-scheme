import { Injectable } from '@nestjs/common';
import { RequestContext } from '../context/request-context';
import { Prisma } from '../../generated/prisma/client';
import type { Db } from '../prisma/prisma.service';
import { redactForAudit } from './redact';

export interface AuditEntry {
  /** Dotted verb, e.g. 'program.publish', 'reward.approve', 'settings.update'. */
  action: string;
  /** e.g. 'program', 'reward', 'user', 'platform_settings'. */
  resourceType: string;
  resourceId?: string | null;
  /**
   * Program the entry belongs to. Set it for program-scoped resources (programs, options, policies,
   * enrollments, events, rewards) so PROGRAM_ADMIN history views can be scoped (business rules §13).
   */
  programId?: string | null;
  /** Explicit allow-list of the changed fields (old values). Secrets are stripped, emails/phones masked. */
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /**
   * Override the actor (defaults to the request's AuthContext). Pass `null` for system actions
   * (scheduler/worker); in that case actorRoles defaults to ['SYSTEM'].
   */
  actorUserId?: string | null;
  actorRoles?: string[];
}

/**
 * Append-only audit trail. Call INSIDE the business transaction:
 *   await this.audit.record(tx, { action: 'reward.approve', resourceType: 'reward', resourceId, before, after });
 * requestId / ip come from the request context; actor + roles from the AuthContext.
 * `before`/`after` are JSON-normalized (bigint → string), stripped of secret-looking keys (password*,
 * token*, otp, codeHash, secret*, csrfToken, apiKey, keyHash, codeCiphertext, … — the DB CHECK rejects
 * them) and emails/phones are masked (`a***@e***.com`), recursively. `code` alone is allowed.
 */
@Injectable()
export class AuditService {
  async record(db: Db, entry: AuditEntry): Promise<{ id: string }> {
    const ctx = RequestContext.current();
    const auth = ctx?.auth ?? null;
    const actorUserId = entry.actorUserId !== undefined ? entry.actorUserId : (auth?.userId ?? null);
    let actorRoles: string[];
    if (entry.actorRoles) actorRoles = entry.actorRoles;
    else if (actorUserId === null) actorRoles = ['SYSTEM'];
    else if (auth && actorUserId === auth.userId) actorRoles = [...auth.roles];
    else actorRoles = [];
    const row = await db.auditLog.create({
      data: {
        actorUserId,
        actorRoles,
        action: entry.action.slice(0, 96),
        resourceType: entry.resourceType.slice(0, 64),
        resourceId: entry.resourceId?.slice(0, 64) ?? null,
        programId: entry.programId ?? null,
        before: toJsonInput(entry.before),
        after: toJsonInput(entry.after),
        reason: entry.reason?.slice(0, 1000) ?? null,
        requestId: ctx?.requestId?.slice(0, 64) ?? null,
        ipAddress: ctx?.ip?.slice(0, 64) ?? null,
      },
      select: { id: true },
    });
    return row;
  }
}

function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return redactForAudit(value) as Prisma.InputJsonValue;
}
