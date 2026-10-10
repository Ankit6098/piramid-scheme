import { Injectable } from '@nestjs/common';
import type { ApiPage, NotificationDto, NotificationListQuery } from '@app/shared';
import { z } from 'zod';
import { decodeCursor, paginate } from '../../common/pagination/cursor';
import { notFound } from '../../common/errors/app-error';
import { OutboxService } from '../../common/outbox/outbox.service';
import type { NotificationCreatePayload } from '../../common/outbox/outbox.topics';
import { type Db, PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

export type NotifyInput = NotificationCreatePayload & {
  /** Optional de-duplication key, e.g. `reward-approved:<rewardId>`. */
  dedupeKey?: string;
};

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

const notificationSelect = {
  id: true,
  type: true,
  title: true,
  body: true,
  data: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof notificationSelect }>;

/** Maps a notifications row to the member-facing DTO (only the owner ever receives it). */
export function toNotificationDto(row: NotificationRow): NotificationDto {
  const data = row.data;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * In-app notifications.
 * - `notify()` — CROSS-MODULE CONTRACT used by every slice: notifications are created asynchronously
 *   via the outbox so they commit atomically with the business change and never block it.
 * - list / unread count / mark read — the signed-in user's own notifications only (every query is
 *   keyed by `userId`; another user's id behaves like a missing row → 404).
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Enqueues a `notification.create` outbox message inside `tx`; the worker inserts the
   * `notifications` row after commit (idempotently).
   */
  async notify(tx: Db, input: NotifyInput): Promise<{ outboxId: string; enqueued: boolean }> {
    const { dedupeKey, ...payload } = input;
    const res = await this.outbox.enqueue(tx, {
      topic: 'notification.create',
      payload,
      ...(dedupeKey ? { dedupeKey: `notification:${dedupeKey}` } : {}),
    });
    return { outboxId: res.id, enqueued: res.enqueued };
  }

  /** Newest first; `unread: true` limits to unread ones. */
  async list(userId: string, q: NotificationListQuery): Promise<ApiPage<NotificationDto>> {
    const cursor = decodeCursor(q.cursor, cursorSchema);
    const and: Prisma.NotificationWhereInput[] = [{ userId }];
    if (q.unread === true) and.push({ readAt: null });
    if (q.unread === false) and.push({ readAt: { not: null } });
    if (cursor) {
      const at = new Date(cursor.createdAt);
      and.push({ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] });
    }
    const rows = await this.prisma.notification.findMany({
      where: { AND: and },
      select: notificationSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return paginate(rows, q.limit, (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }), toNotificationDto);
  }

  async unreadCount(userId: string, db: Db = this.prisma): Promise<number> {
    return db.notification.count({ where: { userId, readAt: null } });
  }

  /** Marks one of the user's notifications read (idempotent: keeps the first `readAt`). */
  async markRead(userId: string, id: string): Promise<NotificationDto> {
    await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    const row = await this.prisma.notification.findFirst({ where: { id, userId }, select: notificationSelect });
    if (!row) throw notFound('Notification');
    return toNotificationDto(row);
  }

  /** Marks every unread notification of the user read. */
  async markAllRead(userId: string): Promise<{ updated: number }> {
    const res = await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { updated: res.count };
  }

  /** Latest notifications (dashboard); `typePrefix` + `unreadOnly` select announcements. */
  async latest(
    userId: string,
    opts: { take: number; typePrefix?: string; unreadOnly?: boolean },
    db: Db = this.prisma,
  ): Promise<NotificationDto[]> {
    const rows = await db.notification.findMany({
      where: {
        userId,
        ...(opts.unreadOnly ? { readAt: null } : {}),
        ...(opts.typePrefix ? { type: { startsWith: opts.typePrefix } } : {}),
      },
      select: notificationSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.take,
    });
    return rows.map(toNotificationDto);
  }
}
