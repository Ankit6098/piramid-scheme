// Contracts (Zod request schemas + response types) for the referrals module: referral codes,
// sponsor/ancestor views, the member team tree, admin hierarchy views, sponsor corrections and
// fraud/suspicious-activity flags (business rules §6, §12).

import { z } from 'zod';
import { cursorPageQuerySchema, reasonSchema } from '../api';
import { FlagStatus, type UserStatus } from '../enums';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Members see their descendants up to this depth (business rules §6). */
export const MAX_TEAM_DEPTH = 10;
/** Levels returned by one tree request (`?depth=1..3`); deeper levels are loaded lazily. */
export const MAX_TREE_FETCH_DEPTH = 3;
/** Children returned inline per node in a tree response; the rest via the children endpoint. */
export const TREE_CHILDREN_LIMIT = 50;
/** Upper bound of nodes returned by one tree request (deeper levels are then left unloaded). */
export const MAX_TREE_RESPONSE_NODES = 600;

/** Coarse account state shown to other members instead of the real status. */
export const MemberStatusBucket = ['ACTIVE', 'INACTIVE'] as const;
export type MemberStatusBucket = (typeof MemberStatusBucket)[number];

export const ReferralAttributionSource = ['REGISTRATION', 'ADMIN_CORRECTION'] as const;
export type ReferralAttributionSource = (typeof ReferralAttributionSource)[number];

/** Known flag kinds (the column is free text; heuristics add their own kinds). */
export const FlagKind = {
  SharedIpRegistrations: 'SHARED_IP_REGISTRATIONS',
  ManualReport: 'MANUAL_REPORT',
} as const;
export type FlagKind = (typeof FlagKind)[keyof typeof FlagKind];

// ─── Public: code validation ────────────────────────────────────────────────

export const validateReferralCodeSchema = z.object({
  code: z.string().trim().min(1, 'Enter a referral code').max(32),
});
export type ValidateReferralCodeInput = z.infer<typeof validateReferralCodeSchema>;

export interface ValidateReferralCodeResponse {
  valid: boolean;
  /** First name + last initial of the code owner; only when `valid`. */
  sponsorDisplayName?: string;
}

// ─── Member: own code, sponsor, direct referrals ───────────────────────────

export interface ReferralCodeResponse {
  code: string;
  /** `${APP_PUBLIC_URL}/register?ref=CODE` */
  link: string;
}

/** An upline member as seen by a member (no ids, no contact details). */
export interface UplineMemberDto {
  displayName: string;
  /** 1 = sponsor, 2 = sponsor's sponsor, … */
  depth: number;
  joinedAt: string;
}

export interface MySponsorDto {
  displayName: string;
  joinedAt: string;
  /** When the current attribution was made (registration or an admin correction). */
  attributedAt: string;
  attributionSource: ReferralAttributionSource;
}

export interface MyParentResponse {
  sponsor: MySponsorDto;
  /** Sponsor first (depth 1), then upwards; at most MAX_TEAM_DEPTH levels. */
  ancestors: UplineMemberDto[];
  /** True when the upline continues beyond the returned levels. */
  hasMoreAncestors: boolean;
}

export const directReferralsQuerySchema = cursorPageQuerySchema.extend({
  status: z.enum(MemberStatusBucket).optional(),
});
export type DirectReferralsQuery = z.infer<typeof directReferralsQuerySchema>;

/** A downline member as seen by a member (business rules §6 — privacy-filtered). */
export interface DownlineMemberDto {
  id: string;
  displayName: string;
  /** Depth relative to the viewer (1 = direct referral). */
  depth: number;
  joinedAt: string;
  statusBucket: MemberStatusBucket;
  /** Holds an ELIGIBLE, currently covering enrollment in any program. */
  hasEligibleEnrollment: boolean;
  /** Direct referrals of this member that the viewer may see (0 at the depth limit). */
  childCount: number;
}

export interface DirectReferralDto extends DownlineMemberDto {
  attributedAt: string;
}

// ─── Member: team (hierarchy) ───────────────────────────────────────────────

export interface TeamDepthCount {
  depth: number;
  count: number;
}

export interface TeamSummaryResponse {
  directCount: number;
  /** Members within MAX_TEAM_DEPTH (or the whole subtree for admin views). */
  teamSize: number;
  countsByDepth: TeamDepthCount[];
  activeCount: number;
  inactiveCount: number;
  /** Members currently holding an ELIGIBLE enrollment. */
  withEligibleEnrollmentCount: number;
  /** The depth limit applied (null = unlimited, admin views). */
  maxDepth: number | null;
}

export const hierarchyTreeQuerySchema = z.object({
  /** Defaults to the viewer (or the admin-viewed member). */
  rootId: z.uuid().optional(),
  depth: z.coerce.number().int().min(1).max(MAX_TREE_FETCH_DEPTH).default(2),
});
export type HierarchyTreeQuery = z.infer<typeof hierarchyTreeQuerySchema>;

export const hierarchyChildrenQuerySchema = cursorPageQuerySchema.extend({
  parentId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(TREE_CHILDREN_LIMIT),
});
export type HierarchyChildrenQuery = z.infer<typeof hierarchyChildrenQuerySchema>;

export const hierarchySearchQuerySchema = cursorPageQuerySchema.extend({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(64),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type HierarchySearchQuery = z.infer<typeof hierarchySearchQuerySchema>;

export const hierarchyMemberParamSchema = z.object({ memberId: z.uuid() });

export interface TeamNodeDto extends DownlineMemberDto {
  /** Loaded children (≤ TREE_CHILDREN_LIMIT, oldest attribution first). */
  children: TeamNodeDto[];
  /** False when this node's children were not part of the response (load them lazily). */
  childrenLoaded: boolean;
  /** More children exist than `children` holds (use the children endpoint with `nextCursor`). */
  hasMoreChildren: boolean;
  /** Cursor for the children endpoint continuing after the last loaded child. */
  childrenCursor: string | null;
}

export interface TeamTreeResponse {
  root: TeamNodeDto;
  /** Depth limit relative to the viewer (null = unlimited, admin views). */
  maxDepth: number | null;
  /** True when the node budget stopped deeper levels from being loaded. */
  truncated: boolean;
}

export interface TeamPathNodeDto {
  id: string;
  displayName: string;
  depth: number;
}

export interface TeamPathResponse {
  /** From the viewer (depth 0) down to the requested member. */
  nodes: TeamPathNodeDto[];
}

export interface TeamSearchResultDto {
  id: string;
  displayName: string;
  depth: number;
  statusBucket: MemberStatusBucket;
}

// ─── Admin: hierarchy ───────────────────────────────────────────────────────

/**
 * Admin view of a member in a tree. `fullName`/`status` are null for members a PROGRAM_ADMIN may
 * not read (not enrolled in one of their programs) — they are shown with the display name only.
 */
export interface AdminDownlineMemberDto extends DownlineMemberDto {
  fullName: string | null;
  status: UserStatus | null;
  inScope: boolean;
}

export interface AdminTeamNodeDto extends AdminDownlineMemberDto {
  children: AdminTeamNodeDto[];
  childrenLoaded: boolean;
  hasMoreChildren: boolean;
  childrenCursor: string | null;
}

export interface AdminTeamTreeResponse extends Omit<TeamTreeResponse, 'root'> {
  root: AdminTeamNodeDto;
}

export interface AdminTeamPathNodeDto extends TeamPathNodeDto {
  fullName: string | null;
}

export interface AdminTeamPathResponse {
  nodes: AdminTeamPathNodeDto[];
}

export interface AdminTeamSearchResultDto extends TeamSearchResultDto {
  fullName: string | null;
}

export interface AdminAncestorDto {
  id: string;
  displayName: string;
  fullName: string | null;
  status: UserStatus | null;
  inScope: boolean;
  /** 1 = sponsor. */
  depth: number;
  joinedAt: string;
}

export interface AdminAncestorsResponse {
  memberId: string;
  /** Sponsor first. Empty for a root member. */
  ancestors: AdminAncestorDto[];
  /** How the member's current sponsor link was made (null = no sponsor). */
  attributionSource: ReferralAttributionSource | null;
  attributedAt: string | null;
}

// ─── Admin: sponsor correction ──────────────────────────────────────────────

export const sponsorCorrectionPreviewQuerySchema = z.object({ newSponsorId: z.uuid() });
export type SponsorCorrectionPreviewQuery = z.infer<typeof sponsorCorrectionPreviewQuerySchema>;

export const sponsorCorrectionSchema = z.object({
  newSponsorId: z.uuid(),
  reason: reasonSchema,
});
export type SponsorCorrectionInput = z.infer<typeof sponsorCorrectionSchema>;

export const SponsorCorrectionIssueCode = [
  'SAME_SPONSOR',
  'SELF_SPONSOR',
  'CYCLE',
  'SPONSOR_INACTIVE',
  'SEGREGATION_OF_DUTIES',
  'RECEIVED_EVENTS',
] as const;
export type SponsorCorrectionIssueCode = (typeof SponsorCorrectionIssueCode)[number];

export interface SponsorCorrectionIssue {
  code: SponsorCorrectionIssueCode;
  message: string;
}

export interface CorrectionMemberRef {
  id: string;
  fullName: string;
  status: UserStatus;
}

export interface SponsorCorrectionPreviewResponse {
  member: CorrectionMemberRef;
  currentSponsor: CorrectionMemberRef | null;
  newSponsor: CorrectionMemberRef;
  /** Members that move with the correction (the member + their whole subtree). */
  affectedMembers: number;
  /** Depth of the member below the new sponsor's root after the move (new sponsor depth + 1). */
  newDepthFromRoot: number;
  /** Unprocessed sales in the moved subtree (must be 0). */
  receivedEventCount: number;
  issues: SponsorCorrectionIssue[];
  canApply: boolean;
}

export interface SponsorCorrectionResponse {
  correctionId: string;
  memberId: string;
  previousSponsorId: string | null;
  newSponsorId: string;
  affectedMembers: number;
  createdAt: string;
}

// ─── Admin: flags ───────────────────────────────────────────────────────────

export const listFlagsQuerySchema = cursorPageQuerySchema.extend({
  status: z.enum(FlagStatus).optional(),
  kind: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'Unknown flag kind')
    .optional(),
  userId: z.uuid().optional(),
});
export type ListFlagsQuery = z.infer<typeof listFlagsQuerySchema>;

export const createFlagSchema = z.object({
  userId: z.uuid(),
  details: z
    .string()
    .trim()
    .min(10, 'Describe the concern (at least 10 characters)')
    .max(2000),
});
export type CreateFlagInput = z.infer<typeof createFlagSchema>;

export const resolveFlagSchema = z.object({
  status: z.enum(['RESOLVED', 'DISMISSED']),
  resolution: reasonSchema,
});
export type ResolveFlagInput = z.infer<typeof resolveFlagSchema>;

export interface FlagUserRef {
  id: string;
  fullName: string;
}

export interface FlagDto {
  id: string;
  kind: string;
  details: string;
  status: FlagStatus;
  user: FlagUserRef & { status: UserStatus };
  createdBy: FlagUserRef | null;
  resolvedBy: FlagUserRef | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
