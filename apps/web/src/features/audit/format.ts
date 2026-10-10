/** Presentation helpers for audit entries (shared by the audit log and the admin overview). */

const ACTION_LABELS: Record<string, string> = {
  'member.suspend': 'Suspended member',
  'member.reactivate': 'Reactivated member',
  'member.roles.update': 'Changed member roles',
  'settings.update': 'Updated platform settings',
  'program.publish': 'Published program',
  'program.update': 'Updated program',
  'program.status': 'Changed program status',
  'policy.publish': 'Published reward policy',
  'policy.retire': 'Retired reward policy',
  'reward.approve': 'Approved reward',
  'reward.reject': 'Rejected reward',
  'reward.reverse': 'Reversed reward',
  'event.record': 'Recorded sale',
  'event.reverse': 'Reversed sale',
  'enrollment.activate': 'Activated enrollment',
  'enrollment.reject': 'Rejected enrollment',
  'offering.approve': 'Approved offering',
  'referral.correct': 'Corrected referral',
};

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Human label for an audit action code (`member.roles.update` → "Changed member roles"). */
export function auditActionLabel(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const words = action
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
  return words.length ? capitalize(words.join(' ')) : action;
}

/** `policy_version` → "Policy version". */
export function resourceTypeLabel(type: string): string {
  return capitalize(type.replace(/[_-]+/g, ' ').toLowerCase());
}

/** Short form of a long id for tables (`5f2c…9a1b`). */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** Common resource types (filter suggestions; any value is accepted). */
export const KNOWN_RESOURCE_TYPES = [
  'user',
  'program',
  'program_option',
  'policy_version',
  'enrollment',
  'event',
  'reward',
  'offering',
  'platform_settings',
  'referral',
  'member_flag',
  'api_client',
] as const;
