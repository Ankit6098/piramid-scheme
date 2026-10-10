/**
 * Draft-editor form model. The schema is `policyFieldsSchema` from `@app/shared` (the same one the
 * API validates PATCH bodies with) with friendlier "required" messages for the numeric inputs, so
 * the parsed output is already in request shape.
 */
import type { FieldPath } from 'react-hook-form';
import { z } from 'zod';
import {
  DRY_RUN_MAX_ANCESTORS,
  minorAmountSchema,
  policyFieldsSchema,
  positiveMinorAmountSchema,
  QualifyingEventType,
  type PolicyChangesInput,
  type PolicyIssueDto,
  type PolicyVersionDto,
} from '@app/shared';

export const policyFormSchema = policyFieldsSchema.extend({
  maxDepth: z.number({ error: 'Choose the maximum depth' }).pipe(policyFieldsSchema.shape.maxDepth),
  budgetBps: z
    .number({ error: 'Enter the total budget as a percentage of the sale' })
    .pipe(policyFieldsSchema.shape.budgetBps),
  minEventAmountMinor: z
    .string({ error: 'Enter the minimum sale amount (0 for no minimum)' })
    .min(1, 'Enter the minimum sale amount (0 for no minimum)')
    .pipe(minorAmountSchema),
  pointsPerCurrencyUnit: z
    .number({ error: 'Enter how many points one currency unit earns' })
    .pipe(policyFieldsSchema.shape.pointsPerCurrencyUnit),
});

export type PolicyFormValues = z.input<typeof policyFormSchema>;
export type PolicyFormOutput = z.output<typeof policyFormSchema>;
export type PolicyRuleFormValues = PolicyFormValues['rules'][number];

/** Stored version → form values. Rules are shown in level order. */
export function toFormValues(
  policy: PolicyVersionDto,
  options: { canAutoApprove: boolean },
): PolicyFormValues {
  return {
    name: policy.name,
    notes: policy.notes ?? '',
    triggerEventTypes: [...policy.triggerEventTypes],
    maxDepth: policy.maxDepth,
    budgetBps: policy.budgetBps,
    maxTotalPerEventMinor: policy.maxTotalPerEventMinor,
    minEventAmountMinor: policy.minEventAmountMinor,
    pointsPerCurrencyUnit: policy.pointsPerCurrencyUnit,
    ineligibleAncestorBehavior: policy.ineligibleAncestorBehavior,
    roundingMode: policy.roundingMode,
    // Without `policies:auto-approve` manual approval is forced on (the API refuses to publish otherwise).
    requiresApproval: options.canAutoApprove ? policy.requiresApproval : true,
    requireActiveEnrollment: policy.requireActiveEnrollment,
    rules: [...policy.rules]
      .sort((a, b) => a.level - b.level)
      .map((rule) => ({
        level: rule.level,
        calcType: rule.calcType,
        fixedAmountMinor: rule.fixedAmountMinor,
        percentageBps: rule.percentageBps,
        capMinor: rule.capMinor,
      })),
  };
}

/** Parsed form output → request body fields (PATCH / validate `changes` / dry-run `changes`). */
export function toPolicyChanges(output: PolicyFormOutput): PolicyChangesInput {
  return { ...output, notes: output.notes ? output.notes : null };
}

/** Lowest level in 1..maxDepth that no rule uses yet (null when all are taken). */
export function nextFreeLevel(
  rules: ReadonlyArray<{ level?: unknown } | undefined>,
  maxDepth: number,
): number | null {
  const used = new Set(rules.map((rule) => rule?.level));
  for (let level = 1; level <= maxDepth; level++) {
    if (!used.has(level)) return level;
  }
  return null;
}

const TOP_LEVEL_FIELDS = [
  'name',
  'notes',
  'triggerEventTypes',
  'maxDepth',
  'budgetBps',
  'maxTotalPerEventMinor',
  'minEventAmountMinor',
  'pointsPerCurrencyUnit',
  'ineligibleAncestorBehavior',
  'roundingMode',
  'requiresApproval',
  'requireActiveEnrollment',
] as const;
const RULE_FIELDS = ['level', 'calcType', 'fixedAmountMinor', 'percentageBps', 'capMinor'] as const;

/** Field paths of the form that can receive focus from an issue link. */
export function isFocusablePath(path: string): boolean {
  return (
    /^rules\.\d+\.(level|calcType|fixedAmountMinor|percentageBps|capMinor)$/.test(path) ||
    (TOP_LEVEL_FIELDS as readonly string[]).includes(path)
  );
}

/** Every rendered field path for `ruleCount` rules (to map server field errors onto inputs). */
export function formFieldPaths(ruleCount: number): FieldPath<PolicyFormValues>[] {
  const rulePaths = Array.from({ length: ruleCount }, (_, i) =>
    RULE_FIELDS.map((field) => `rules.${i}.${field}` as const),
  ).flat();
  return [...TOP_LEVEL_FIELDS, ...rulePaths];
}

/** Zod issues of an unparseable form → the same shape as server issues (for one combined list). */
export function clientIssues(error: z.ZodError): PolicyIssueDto[] {
  const seen = new Set<string>();
  const issues: PolicyIssueDto[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map(String).join('.');
    if (seen.has(path)) continue;
    seen.add(path);
    issues.push({ severity: 'error', path, message: issue.message });
  }
  return issues;
}

/** Reads `details.issues` of a 400 POLICY_INVALID error (defensive: unknown shapes → []). */
export function issuesFromErrorDetails(details: unknown): PolicyIssueDto[] {
  const raw =
    details &&
    typeof details === 'object' &&
    Array.isArray((details as { issues?: unknown }).issues)
      ? ((details as { issues: unknown[] }).issues as unknown[])
      : [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const i = item as Partial<PolicyIssueDto> & { path?: unknown };
    if (typeof i.message !== 'string') return [];
    const path = Array.isArray(i.path) ? i.path.map(String).join('.') : String(i.path ?? '');
    return [
      {
        severity: i.severity === 'warning' ? 'warning' : 'error',
        path,
        message: i.message,
        code: typeof i.code === 'string' ? i.code : undefined,
      } satisfies PolicyIssueDto,
    ];
  });
}

// ─── Dry-run form ────────────────────────────────────────────────────────────

export const dryRunFormSchema = z
  .object({
    eventType: z.enum(QualifyingEventType, { error: 'Choose a sale type' }),
    saleAmountMinor: z
      .string({ error: 'Enter the sale amount' })
      .min(1, 'Enter the sale amount')
      .pipe(positiveMinorAmountSchema),
    mode: z.enum(['SYNTHETIC', 'MEMBER']),
    ancestors: z
      .array(z.object({ eligible: z.boolean() }))
      .max(DRY_RUN_MAX_ANCESTORS, `At most ${DRY_RUN_MAX_ANCESTORS} upline members`),
    subjectUserId: z.string().trim(),
    occurredAt: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.mode !== 'MEMBER') return;
    if (!z.uuid().safeParse(value.subjectUserId).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['subjectUserId'],
        message: 'Enter the member ID (a UUID such as 3f2b…-…)',
      });
    }
  });

export type DryRunFormValues = z.input<typeof dryRunFormSchema>;
export type DryRunFormOutput = z.output<typeof dryRunFormSchema>;
