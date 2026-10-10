import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type AdminAncestorsResponse,
  type AdminDownlineMemberDto,
  type AdminTeamPathResponse,
  type AdminTeamSearchResultDto,
  type AdminTeamTreeResponse,
  type ApiPage,
  type ApiResponse,
  type SponsorCorrectionPreviewResponse,
  type SponsorCorrectionResponse,
  type TeamSummaryResponse,
} from '@app/shared';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import { ok } from '../../common/http/envelope';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { IdParamDto } from '../../common/validation/zod';
import { AdminHierarchyService } from './admin-hierarchy.service';
import {
  AdminMemberPathParamDto,
  HierarchyChildrenQueryDto,
  HierarchySearchQueryDto,
  HierarchyTreeQueryDto,
  SponsorCorrectionDto,
  SponsorCorrectionPreviewQueryDto,
} from './dto';
import { SponsorCorrectionService } from './sponsor-correction.service';

/**
 * Admin views of a member's referral network and the audited sponsor correction
 * (/api/v1/admin/members/:id/...). Admin role + TOTP session enforced by the core guard.
 */
@ApiTags('admin: referrals')
@Controller('admin/members')
export class AdminNetworkController {
  constructor(
    private readonly hierarchy: AdminHierarchyService,
    private readonly corrections: SponsorCorrectionService,
  ) {}

  @Get(':id/hierarchy')
  @RequirePermissions(Permission.MembersRead)
  async tree(
    @CurrentUser() auth: AuthContext,
    @Param() p: IdParamDto,
    @Query() q: HierarchyTreeQueryDto,
  ): Promise<ApiResponse<AdminTeamTreeResponse>> {
    return ok(await this.hierarchy.getTree(auth, p.id, q));
  }

  @Get(':id/hierarchy/summary')
  @RequirePermissions(Permission.MembersRead)
  async summary(@CurrentUser() auth: AuthContext, @Param() p: IdParamDto): Promise<ApiResponse<TeamSummaryResponse>> {
    return ok(await this.hierarchy.getSummary(auth, p.id));
  }

  @Get(':id/hierarchy/children')
  @RequirePermissions(Permission.MembersRead)
  async children(
    @CurrentUser() auth: AuthContext,
    @Param() p: IdParamDto,
    @Query() q: HierarchyChildrenQueryDto,
  ): Promise<ApiPage<AdminDownlineMemberDto>> {
    return this.hierarchy.getChildren(auth, p.id, q);
  }

  @Get(':id/hierarchy/path/:memberId')
  @RequirePermissions(Permission.MembersRead)
  async path(
    @CurrentUser() auth: AuthContext,
    @Param() p: AdminMemberPathParamDto,
  ): Promise<ApiResponse<AdminTeamPathResponse>> {
    return ok(await this.hierarchy.getPath(auth, p.id, p.memberId));
  }

  @Get(':id/hierarchy/search')
  @RequirePermissions(Permission.MembersRead)
  async search(
    @CurrentUser() auth: AuthContext,
    @Param() p: IdParamDto,
    @Query() q: HierarchySearchQueryDto,
  ): Promise<ApiPage<AdminTeamSearchResultDto>> {
    return this.hierarchy.search(auth, p.id, q);
  }

  @Get(':id/ancestors')
  @RequirePermissions(Permission.MembersRead)
  async ancestors(@CurrentUser() auth: AuthContext, @Param() p: IdParamDto): Promise<ApiResponse<AdminAncestorsResponse>> {
    return ok(await this.hierarchy.getAncestors(auth, p.id));
  }

  @Get(':id/sponsor-correction/preview')
  @RequirePermissions(Permission.ReferralsCorrect)
  async previewCorrection(
    @CurrentUser() auth: AuthContext,
    @Param() p: IdParamDto,
    @Query() q: SponsorCorrectionPreviewQueryDto,
  ): Promise<ApiResponse<SponsorCorrectionPreviewResponse>> {
    return ok(await this.corrections.preview(auth, p.id, q.newSponsorId));
  }

  /** Optional `Idempotency-Key`: a retried submit replays the first result instead of failing. */
  @Post(':id/sponsor-correction')
  @RequirePermissions(Permission.ReferralsCorrect)
  @Idempotent({ required: false })
  async correct(
    @CurrentUser() auth: AuthContext,
    @Param() p: IdParamDto,
    @Body() body: SponsorCorrectionDto,
  ): Promise<ApiResponse<SponsorCorrectionResponse>> {
    return ok(await this.corrections.apply(auth, p.id, body));
  }
}
