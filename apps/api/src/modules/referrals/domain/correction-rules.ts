import type { SponsorCorrectionIssue, UserStatus } from '@app/shared';

/**
 * Facts about a proposed sponsor correction, loaded under the exclusive referral-tree lock
 * (or without it for a preview).
 */
export interface CorrectionFacts {
  memberId: string;
  performerId: string;
  currentSponsorId: string | null;
  newSponsor: { id: string; status: UserStatus; emailVerified: boolean };
  /** The new sponsor is the member or inside the member's subtree (closure row member → sponsor). */
  newSponsorInMemberSubtree: boolean;
  /** The performer is the new sponsor or one of its uplines (closure row performer → sponsor). */
  performerIsUplineOfNewSponsor: boolean;
  /** RECEIVED (unprocessed) sales whose subject is in the moved subtree. */
  receivedEventCount: number;
}

/**
 * Business rules §3, §6: a correction must not create a cycle, must change the sponsor, needs an
 * ACTIVE + verified new sponsor, may not be performed by the moved member, the previous or new
 * sponsor or an upline of the new sponsor (segregation of duties), and is refused while the moved
 * subtree has unprocessed sales. The DB enforces the cycle and SoD rules again.
 */
export function evaluateSponsorCorrection(f: CorrectionFacts): SponsorCorrectionIssue[] {
  const issues: SponsorCorrectionIssue[] = [];
  if (f.newSponsor.id === f.memberId) {
    issues.push({ code: 'SELF_SPONSOR', message: 'A member cannot be their own sponsor.' });
  } else if (f.newSponsorInMemberSubtree) {
    issues.push({
      code: 'CYCLE',
      message: "The new sponsor is in this member's own team; moving would create a cycle.",
    });
  }
  if (f.currentSponsorId !== null && f.currentSponsorId === f.newSponsor.id) {
    issues.push({ code: 'SAME_SPONSOR', message: 'This member is already sponsored by the selected member.' });
  }
  if (f.newSponsor.status !== 'ACTIVE' || !f.newSponsor.emailVerified) {
    issues.push({ code: 'SPONSOR_INACTIVE', message: 'The new sponsor must be an active, verified member.' });
  }
  if (
    f.performerId === f.memberId ||
    f.performerId === f.currentSponsorId ||
    f.performerId === f.newSponsor.id ||
    f.performerIsUplineOfNewSponsor
  ) {
    issues.push({
      code: 'SEGREGATION_OF_DUTIES',
      message:
        'You cannot correct a placement that involves yourself: the member, the current or new sponsor, or a member in your own team.',
    });
  }
  if (f.receivedEventCount > 0) {
    issues.push({
      code: 'RECEIVED_EVENTS',
      message: `The moved team has ${f.receivedEventCount} sale(s) awaiting processing. Wait until they are processed.`,
    });
  }
  return issues;
}
