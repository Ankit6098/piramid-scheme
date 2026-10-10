import { Injectable } from '@nestjs/common';
import {
  ANNOUNCEMENT_NOTIFICATION_PREFIX,
  type MemberDashboardActivityDto,
  type MemberDashboardDto,
  type MemberDashboardEnrollmentDto,
  type RewardStatus,
} from '@app/shared';
import { type AuthContext, notFound, PrismaService } from '../../common';
import { NotificationsService } from '../notifications/notifications.service';
import { firstNameOf } from './domain/admin-rules';
import { loadRewardSummary, toRewardSummaryDto } from './reward-summary';

/** Members can see their team up to this depth (business rules §6). */
export const MEMBER_VISIBLE_DEPTH = 10;
const RECENT_ACTIVITY_LIMIT = 10;

/**
 * The member's own dashboard (GET /users/me/dashboard). Only the caller's data; reward activity is
 * privacy-filtered (business rules §10): program name, level, amount, unit, status and date — never the
 * sale's subject, sale amount, customer, external id or calculation trace.
 */
@Injectable()
export class MemberDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async getDashboard(auth: AuthContext): Promise<MemberDashboardDto> {
    const userId = auth.userId;
    const db = this.prisma;
    const [user, enrollmentRows, enrollmentCounts, directCount, teamSize, rewards, unread, notifications, rewardRows, announcements] =
      await Promise.all([
        db.user.findUnique({
          where: { id: userId },
          select: { id: true, fullName: true, status: true, emailVerifiedAt: true, createdAt: true },
        }),
        db.programEnrollment.findMany({
          where: { userId, status: { in: ['ACTIVE', 'PENDING'] } },
          select: {
            id: true,
            status: true,
            eligibilityStatus: true,
            effectiveFrom: true,
            effectiveTo: true,
            optionSnapshot: true,
            option: { select: { name: true } },
            program: { select: { id: true, code: true, name: true } },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 5,
        }),
        db.programEnrollment.groupBy({
          by: ['status'],
          where: { userId, status: { in: ['ACTIVE', 'PENDING'] } },
          _count: { _all: true },
        }),
        db.referralRelationship.count({ where: { sponsorUserId: userId } }),
        db.referralPath.count({ where: { ancestorId: userId, depth: { gte: 1, lte: MEMBER_VISIBLE_DEPTH } } }),
        loadRewardSummary(db, userId, 'ALL'),
        this.notifications.unreadCount(userId, db),
        this.notifications.latest(userId, { take: 5 }, db),
        db.reward.findMany({
          where: { recipientUserId: userId },
          select: {
            id: true,
            level: true,
            amountMinor: true,
            rewardUnit: true,
            currencyCode: true,
            status: true,
            createdAt: true,
            approvedAt: true,
            postedAt: true,
            rejectedAt: true,
            reversedAt: true,
            program: { select: { name: true } },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: 5,
        }),
        this.notifications.latest(userId, { take: 3, typePrefix: ANNOUNCEMENT_NOTIFICATION_PREFIX, unreadOnly: true }, db),
      ]);
    if (!user) throw notFound('Account');

    const statusAt = (r: (typeof rewardRows)[number]): Date => {
      const byStatus: Record<RewardStatus, Date | null> = {
        PENDING_APPROVAL: r.createdAt,
        APPROVED: r.approvedAt,
        POSTED: r.postedAt,
        REJECTED: r.rejectedAt,
        REVERSED: r.reversedAt,
      };
      return byStatus[r.status] ?? r.createdAt;
    };

    const activity: MemberDashboardActivityDto[] = [
      ...rewardRows.map(
        (r): MemberDashboardActivityDto => ({
          kind: 'REWARD',
          id: `reward:${r.id}:${r.status}`,
          at: statusAt(r).toISOString(),
          rewardId: r.id,
          programName: r.program.name,
          level: r.level,
          amountMinor: r.amountMinor.toString(),
          rewardUnit: r.rewardUnit,
          currencyCode: r.currencyCode.trim(),
          status: r.status,
        }),
      ),
      ...notifications.map(
        (n): MemberDashboardActivityDto => ({
          kind: 'NOTIFICATION',
          id: `notification:${n.id}`,
          at: n.createdAt,
          notificationId: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          read: n.readAt !== null,
        }),
      ),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, RECENT_ACTIVITY_LIMIT);

    const countOf = (status: 'ACTIVE' | 'PENDING') => enrollmentCounts.find((c) => c.status === status)?._count._all ?? 0;

    return {
      user: {
        id: user.id,
        fullName: user.fullName,
        firstName: firstNameOf(user.fullName),
        status: user.status,
        emailVerified: user.emailVerifiedAt !== null,
        memberSince: user.createdAt.toISOString(),
      },
      enrollments: {
        active: countOf('ACTIVE'),
        pending: countOf('PENDING'),
        items: enrollmentRows.map((e): MemberDashboardEnrollmentDto => {
          const snapshot = (e.optionSnapshot ?? {}) as { name?: unknown };
          return {
            id: e.id,
            program: e.program,
            optionName: typeof snapshot.name === 'string' ? snapshot.name : e.option.name,
            status: e.status as MemberDashboardEnrollmentDto['status'],
            eligibilityStatus: e.eligibilityStatus,
            effectiveFrom: e.effectiveFrom?.toISOString() ?? null,
            effectiveTo: e.effectiveTo?.toISOString() ?? null,
          };
        }),
      },
      referrals: { directCount, teamSize },
      rewards: rewards.map(toRewardSummaryDto),
      unreadNotifications: unread,
      recentActivity: activity,
      announcements,
    };
  }
}
