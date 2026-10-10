import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type AuthContext, CurrentUser, IdParamDto, ok } from '../../common';
import { NotificationListQueryDto } from './dto';
import { NotificationsService } from './notifications.service';

/**
 * The signed-in user's in-app notifications (/api/v1/users/me/notifications) — HTTP only.
 * Every route is scoped to `auth.userId`; mutations go through the global CSRF guard.
 */
@ApiTags('notifications')
@Controller('users/me/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'My notifications, newest first (cursor; `unread=true` for unread only)' })
  list(@Query() q: NotificationListQueryDto, @CurrentUser() auth: AuthContext) {
    return this.notifications.list(auth.userId, q);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of unread notifications (polled by the top-bar bell)' })
  async unreadCount(@CurrentUser() auth: AuthContext) {
    return ok({ count: await this.notifications.unreadCount(auth.userId) });
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all my notifications read' })
  async readAll(@CurrentUser() auth: AuthContext) {
    return ok(await this.notifications.markAllRead(auth.userId));
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one of my notifications read (404 for anyone else’s)' })
  async read(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.notifications.markRead(auth.userId, p.id));
  }
}
