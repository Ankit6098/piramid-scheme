import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
  ApiPage,
  ApiResponse,
  DirectReferralDto,
  DownlineMemberDto,
  MyParentResponse,
  ReferralCodeResponse,
  TeamPathResponse,
  TeamSearchResultDto,
  TeamSummaryResponse,
  TeamTreeResponse,
} from '@app/shared';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser } from '../../common/auth/decorators';
import { ok } from '../../common/http/envelope';
import {
  DirectReferralsQueryDto,
  HierarchyChildrenQueryDto,
  HierarchyMemberParamDto,
  HierarchySearchQueryDto,
  HierarchyTreeQueryDto,
} from './dto';
import { ReferralCodesService } from './referral-codes.service';
import { TeamService } from './team.service';

/**
 * The signed-in member's own network (/api/v1/users/me/...): referral code, sponsor + upline,
 * direct referrals and the team tree (business rules §6 — privacy-filtered, depth ≤ 10).
 */
@ApiTags('referrals')
@Controller('users/me')
export class MemberNetworkController {
  constructor(
    private readonly codes: ReferralCodesService,
    private readonly team: TeamService,
  ) {}

  @Get('referral-code')
  async referralCode(@CurrentUser() auth: AuthContext): Promise<ApiResponse<ReferralCodeResponse>> {
    return ok(await this.codes.getOwnCode(auth.userId));
  }

  /** `data` is null for a member without a sponsor. */
  @Get('parent')
  async parent(@CurrentUser() auth: AuthContext): Promise<ApiResponse<MyParentResponse | null>> {
    return ok(await this.team.getParent(auth.userId));
  }

  @Get('referrals')
  async directReferrals(
    @CurrentUser() auth: AuthContext,
    @Query() q: DirectReferralsQueryDto,
  ): Promise<ApiPage<DirectReferralDto>> {
    return this.team.listDirectReferrals(auth.userId, q);
  }

  @Get('hierarchy/summary')
  async summary(@CurrentUser() auth: AuthContext): Promise<ApiResponse<TeamSummaryResponse>> {
    return ok(await this.team.getSummary(auth.userId));
  }

  @Get('hierarchy/tree')
  async tree(@CurrentUser() auth: AuthContext, @Query() q: HierarchyTreeQueryDto): Promise<ApiResponse<TeamTreeResponse>> {
    return ok(await this.team.getTree(auth.userId, q));
  }

  @Get('hierarchy/children')
  async children(
    @CurrentUser() auth: AuthContext,
    @Query() q: HierarchyChildrenQueryDto,
  ): Promise<ApiPage<DownlineMemberDto>> {
    return this.team.getChildren(auth.userId, q);
  }

  @Get('hierarchy/path/:memberId')
  async path(
    @CurrentUser() auth: AuthContext,
    @Param() p: HierarchyMemberParamDto,
  ): Promise<ApiResponse<TeamPathResponse>> {
    return ok(await this.team.getPath(auth.userId, p.memberId));
  }

  @Get('hierarchy/search')
  async search(
    @CurrentUser() auth: AuthContext,
    @Query() q: HierarchySearchQueryDto,
  ): Promise<ApiPage<TeamSearchResultDto>> {
    return this.team.search(auth.userId, q);
  }
}
