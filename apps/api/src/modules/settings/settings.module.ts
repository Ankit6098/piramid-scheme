import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';

/** Platform settings read (public display format) and SUPER_ADMIN updates (call PlatformSettingsService.invalidate()). */
@Module({
  imports: [],
  controllers: [SettingsController],
  providers: [],
  exports: [],
})
export class SettingsModule {}
