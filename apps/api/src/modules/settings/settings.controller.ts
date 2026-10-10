import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permission } from '@app/shared';
import { CurrentUser, ok, Public, RequirePermissions, type AuthContext } from '../../common';
import { UpdatePlatformSettingsDto } from './dto';
import { SettingsService } from './settings.service';

/** `GET /settings/public` — display format for every client (no session required). */
@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Public()
  @Get('public')
  async getPublic() {
    return ok(await this.settings.getPublic());
  }
}

/** SUPER_ADMIN platform settings (`settings:write`, TOTP-verified admin session). */
@ApiTags('admin/settings')
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermissions(Permission.SettingsWrite)
  async get() {
    return ok(await this.settings.getAdmin());
  }

  @Put()
  @RequirePermissions(Permission.SettingsWrite)
  async update(@Body() body: UpdatePlatformSettingsDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.settings.update(auth, body));
  }
}

/** `GET /admin/currencies` — supported ISO 4217 currencies (reference data). */
@ApiTags('admin/settings')
@Controller('admin/currencies')
export class AdminCurrenciesController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermissions(Permission.SettingsWrite)
  async list() {
    return ok(await this.settings.listCurrencies());
  }
}
