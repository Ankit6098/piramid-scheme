import { Injectable } from '@nestjs/common';
import type { NotificationCreatePayload } from '../../common/outbox/outbox.topics';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OutboxHandlerRegistry, PermanentOutboxError, type OutboxMessageView } from '../outbox/outbox-handler.registry';

/**
 * Handles outbox topic `notification.create`: inserts a `notifications` row. The notification id is
 * the outbox message id, so redelivery is idempotent (ON CONFLICT DO NOTHING).
 */
@Injectable()
export class NotificationOutboxHandler {
  constructor(
    registry: OutboxHandlerRegistry,
    private readonly prisma: PrismaService,
  ) {
    registry.register('notification.create', { handle: (m) => this.handle(m) });
  }

  async handle(message: OutboxMessageView<NotificationCreatePayload>): Promise<void> {
    const p = message.payload;
    if (!p || typeof p.userId !== 'string' || !p.title || !p.body || !p.type) {
      throw new PermanentOutboxError('notification.create payload is incomplete');
    }
    const user = await this.prisma.user.findUnique({ where: { id: p.userId }, select: { id: true } });
    if (!user) throw new PermanentOutboxError('notification.create: user does not exist');
    await this.prisma.notification.createMany({
      data: [
        {
          id: message.id,
          userId: p.userId,
          type: p.type.slice(0, 64),
          title: p.title.slice(0, 200),
          body: p.body.slice(0, 2000),
          data: p.data === undefined ? Prisma.DbNull : (p.data as Prisma.InputJsonValue),
        },
      ],
      skipDuplicates: true,
    });
  }
}
