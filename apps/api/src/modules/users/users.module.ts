import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';

/** Member profile (/users/me), admin member management (suspend/reactivate), role assignment. */
@Module({
  imports: [],
  controllers: [UsersController],
  providers: [],
  exports: [],
})
export class UsersModule {}
