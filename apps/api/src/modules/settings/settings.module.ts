import { Module } from '@nestjs/common';
import { AdminCurrenciesController, AdminSettingsController, SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/** Platform settings read (public display format) and audited SUPER_ADMIN updates. */
@Module({
  imports: [],
  controllers: [SettingsController, AdminSettingsController, AdminCurrenciesController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
