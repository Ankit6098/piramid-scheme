import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { approveOfferingSchema, Permission } from '@app/shared';
import { CurrentUser, IdParamDto, ok, RequirePermissions, type AuthContext } from '../../common';
import { parseOptionalBody } from '../programs/optional-body';
import {
  ApproveOfferingDto,
  CreateOfferingDto,
  DeactivateOfferingDto,
  ListOfferingsQueryDto,
  UpdateOfferingDto,
} from './dto';
import { OfferingsService } from './offerings.service';

/**
 * Admin offerings (approved products/services). Reading needs `programs:read` (program admins pick
 * an offering when creating a program); writing `offerings:write`; approval `offerings:approve`.
 */
@ApiTags('admin/offerings')
@Controller('admin/offerings')
export class AdminOfferingsController {
  constructor(private readonly offerings: OfferingsService) {}

  @Get()
  @RequirePermissions(Permission.ProgramsRead)
  list(@Query() query: ListOfferingsQueryDto) {
    return this.offerings.list(query);
  }

  @Get(':id')
  @RequirePermissions(Permission.ProgramsRead)
  async get(@Param() p: IdParamDto) {
    return ok(await this.offerings.get(p.id));
  }

  @Post()
  @RequirePermissions(Permission.OfferingsWrite)
  async create(@Body() body: CreateOfferingDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.offerings.create(auth, body));
  }

  @Patch(':id')
  @RequirePermissions(Permission.OfferingsWrite)
  async update(@Param() p: IdParamDto, @Body() body: UpdateOfferingDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.offerings.update(auth, p.id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(Permission.OfferingsWrite)
  async remove(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) {
    await this.offerings.delete(auth, p.id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions(Permission.OfferingsApprove)
  @ApiBody({ type: ApproveOfferingDto, required: false })
  async approve(@Param() p: IdParamDto, @Body() body: unknown, @CurrentUser() auth: AuthContext) {
    const input = parseOptionalBody(approveOfferingSchema, body);
    return ok(await this.offerings.approve(auth, p.id, input.reason));
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermissions(Permission.OfferingsApprove)
  async deactivate(@Param() p: IdParamDto, @Body() body: DeactivateOfferingDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.offerings.deactivate(auth, p.id, body.reason));
  }
}
