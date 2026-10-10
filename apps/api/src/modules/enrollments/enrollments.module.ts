import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminEnrollmentsController, EnrollmentsController } from './enrollments.controller';
import { EnrollmentsJobs } from './enrollments.jobs';
import { EnrollmentsService } from './enrollments.service';

/** Member enrollments, admin activation/rejection/cancellation, expiry job. */
@Module({
  imports: [NotificationsModule],
  controllers: [EnrollmentsController, AdminEnrollmentsController],
  providers: [EnrollmentsService, EnrollmentsJobs],
  exports: [EnrollmentsService],
})
export class EnrollmentsModule {}
