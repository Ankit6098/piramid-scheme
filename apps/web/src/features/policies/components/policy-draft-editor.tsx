'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, RefreshCw, Rocket, Save, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import {
  useController,
  useForm,
  useFormState,
  useWatch,
  type Control,
  type FieldPath,
} from 'react-hook-form';
import { toast } from 'sonner';
import {
  ErrorCode,
  formatBps,
  Permission,
  POLICY_HARD_CAP_BPS,
  POLICY_MAX_POINTS_RATE,
  type PolicyContextDto,
  type PolicyIssueDto,
  type PolicyVersionDto,
  type PolicyVersionSummaryDto,
  type PublishPolicyResultDto,
} from '@app/shared';

import { ConfirmDialog } from '@/components/app/confirm-dialog';
import {
  applyApiFieldErrors,
  FormAmountField,
  FormItem,
  FormSelect,
  FormSwitch,
  FormTextarea,
  FormTextField,
  useUnsavedChangesWarning,
} from '@/components/app/form';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useSession } from '@/hooks/use-session';
import { getErrorMessage, isApiError } from '@/lib/api-client';
import { enumOptions } from '@/lib/enum-labels';

import { useDeletePolicyDraft, usePolicyValidation, useUpdatePolicyDraft } from '../api';
import { rewardFormat } from '../format';
import {
  clientIssues,
  formFieldPaths,
  isFocusablePath,
  policyFormSchema,
  toFormValues,
  toPolicyChanges,
  type PolicyFormOutput,
  type PolicyFormValues,
} from '../form';
import { scrollToElement, useDebouncedValue } from '../hooks';
import { issueFieldLabel } from '../labels';
import { policyKeys } from '../query-keys';
import { PanelSectionHeader } from './panel-section-header';
import { DryRunPanel } from './dry-run-panel';
import {
  FormCheckboxGroup,
  FormNumberSelect,
  FormPercentField,
  FormRadioCards,
  FormWholeNumberField,
} from './fields';
import { PolicyIssueList } from './policy-issues';
import { PublishPolicyDialog } from './publish-policy-dialog';
import { RulesEditor } from './rules-editor';

type PolicyControl = Control<PolicyFormValues, unknown, PolicyFormOutput>;

/** Delay between the last edit and the live validation request. */
const VALIDATE_DEBOUNCE_MS = 600;

export interface PolicyDraftEditorProps {
  policy: PolicyVersionDto;
  context: PolicyContextDto;
  versions: readonly PolicyVersionSummaryDto[];
  /** Reports unsaved changes to the page (guards programmatic navigation). Must be stable. */
  onDirtyChange?: (dirty: boolean) => void;
  onDeleted: () => void;
  onPublished: (result: PublishPolicyResultDto) => void;
}

/** Editable DRAFT: form + live policy checks + save / discard / delete / publish + dry run. */
export function PolicyDraftEditor({
  policy,
  context,
  versions,
  onDirtyChange,
  onDeleted,
  onPublished,
}: PolicyDraftEditorProps) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const canPublish = can(Permission.PoliciesPublish);
  const canAutoApprove = can(Permission.PoliciesAutoApprove);
  const program = policy.program;
  const rewardFmt = rewardFormat(program, context.pointsLabel);
  const hardCapBps = context.hardCapBps || POLICY_HARD_CAP_BPS;
  const isPoints = program.rewardUnit === 'POINTS';
  const baseId = useId();
  const rulesSectionId = `${baseId}-rules`;
  const checksId = `${baseId}-checks`;

  const form = useForm<PolicyFormValues, unknown, PolicyFormOutput>({
    resolver: zodResolver(policyFormSchema),
    defaultValues: toFormValues(policy, { canAutoApprove }),
    mode: 'onTouched',
  });
  useUnsavedChangesWarning(form);
  const { isDirty } = useFormState({ control: form.control });

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Optimistic concurrency: the `updatedAt` the form is based on (sent as `expectedUpdatedAt`).
  const [basedOn, setBasedOn] = useState(policy.updatedAt);
  const [staleConflict, setStaleConflict] = useState(false);
  const remoteChanged = policy.updatedAt !== basedOn;
  // Stored as auto-approve but this user can't publish that: the form forces manual approval on, and
  // saving is allowed even without other edits so the draft becomes publishable.
  const approvalNeedsSave = !canAutoApprove && !policy.requiresApproval;

  // ── Live validation ──
  const values = useWatch({ control: form.control });
  const parsed = useMemo(() => policyFormSchema.safeParse(values), [values]);
  const changes = useMemo(() => (parsed.success ? toPolicyChanges(parsed.data) : null), [parsed]);
  const bodyJson = changes ? JSON.stringify({ changes }) : null;
  const debouncedBody = useDebouncedValue(bodyJson, VALIDATE_DEBOUNCE_MS);
  const validation = usePolicyValidation(policy.id, basedOn, debouncedBody);
  const checking = bodyJson !== null && (bodyJson !== debouncedBody || validation.isFetching);
  const shownIssues: PolicyIssueDto[] = parsed.success
    ? (validation.data?.issues ?? [])
    : clientIssues(parsed.error);
  const errorCount = shownIssues.filter((issue) => issue.severity === 'error').length;
  const warningCount = shownIssues.length - errorCount;

  const labelFor = (path: string) => issueFieldLabel(path, values.rules);
  const selectPath = (path: string) => {
    if (isFocusablePath(path)) {
      form.setFocus(path as FieldPath<PolicyFormValues>);
      return;
    }
    scrollToElement(path.startsWith('rules') ? rulesSectionId : checksId);
  };

  // ── Mutations ──
  const update = useUpdatePolicyDraft(policy.id);
  const remove = useDeletePolicyDraft(policy.id);
  const canSave = (isDirty || approvalNeedsSave) && !update.isPending;
  const [publishOpen, setPublishOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [publishOpenedAt, setPublishOpenedAt] = useState(0);

  async function save() {
    const valid = await form.trigger(undefined, { shouldFocus: true });
    const result = policyFormSchema.safeParse(form.getValues());
    if (!valid || !result.success) {
      toast.error('Some fields need attention', {
        description: 'Fix the highlighted fields, then save again.',
      });
      return;
    }
    try {
      const saved = await update.mutateAsync({
        ...toPolicyChanges(result.data),
        expectedUpdatedAt: basedOn,
      });
      // Same tick → one render: the new baseline and the cached version move together.
      setBasedOn(saved.updatedAt);
      setStaleConflict(false);
      form.reset(toFormValues(saved, { canAutoApprove }));
      queryClient.setQueryData(policyKeys.detail(saved.id), saved);
      toast.success('Draft saved');
    } catch (error) {
      if (isApiError(error) && error.code === ErrorCode.StaleVersion) {
        setStaleConflict(true);
        toast.error('Someone else changed this draft', {
          description: 'Load the latest version, then re-apply your changes.',
        });
        void queryClient.invalidateQueries({ queryKey: policyKeys.detail(policy.id) });
        return;
      }
      if (isApiError(error) && error.code === ErrorCode.InvalidStateTransition) {
        toast.error('This version is no longer a draft', { description: error.message });
        void queryClient.invalidateQueries({ queryKey: policyKeys.all });
        return;
      }
      const applied = applyApiFieldErrors(error, form.setError, {
        knownFields: formFieldPaths(form.getValues('rules').length),
      });
      if (!applied) {
        toast.error("Couldn't save the draft", { description: getErrorMessage(error) });
      }
    }
  }

  function loadLatest() {
    form.reset(toFormValues(policy, { canAutoApprove }));
    setBasedOn(policy.updatedAt);
    setStaleConflict(false);
  }

  function openPublish() {
    setPublishOpenedAt(Date.now());
    setPublishOpen(true);
  }

  const maxDepthOptions = Array.from(
    { length: Math.max(program.maxRewardDepth, policy.maxDepth) },
    (_, i) => i + 1,
  ).map((value) => ({
    value,
    label: value > program.maxRewardDepth ? `${value} (above the program limit)` : String(value),
    disabled: value > program.maxRewardDepth,
  }));

  return (
    <div className="space-y-6">
      {remoteChanged || staleConflict ? (
        <Alert className="border-warning/30 bg-warning/5">
          <TriangleAlert aria-hidden className="text-warning" />
          <AlertTitle className="text-warning">This draft was changed elsewhere</AlertTitle>
          <AlertDescription>
            Someone saved a newer version of this draft. Load it to continue
            {isDirty ? ' — your unsaved edits here will be discarded.' : '.'}
          </AlertDescription>
          <AlertAction>
            <Button type="button" size="sm" variant="outline" onClick={loadLatest}>
              <RefreshCw aria-hidden />
              Load latest
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        noValidate
        className="space-y-6"
        aria-label={`Edit draft version ${policy.version}`}
      >
        <Card>
          <CardContent className="space-y-5">
            <PanelSectionHeader title="Basics" />
            <FieldGroup>
              <FormTextField
                control={form.control}
                name="name"
                label="Name"
                maxLength={160}
                autoComplete="off"
                required
              />
              <FormTextarea
                control={form.control}
                name="notes"
                label="Internal notes"
                description="Visible to administrators only."
                maxLength={2000}
                showCount
                rows={3}
              />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-5">
            <PanelSectionHeader
              title="Qualifying sales"
              description="Only sales of the program's approved offering to end customers can earn rewards."
            />
            <FieldGroup>
              <FormCheckboxGroup
                control={form.control}
                name="triggerEventTypes"
                label="Sale types that earn rewards"
                description="Sign-ups, referrals and members' own plan payments are never qualifying sales."
                options={enumOptions('QualifyingEventType')}
                required
              />
              <FormAmountField
                control={form.control}
                name="minEventAmountMinor"
                label="Minimum sale amount"
                description="Smaller sales earn no rewards. Use 0 for no minimum."
                kind="currency"
                currencyCode={program.currencyCode}
                minorUnits={program.currencyMinorUnits}
                required
              />
              {isPoints ? (
                <FormWholeNumberField
                  control={form.control}
                  name="pointsPerCurrencyUnit"
                  label="Points rate"
                  description={`${context.pointsLabel} awarded per 1 ${program.currencyCode} of sale value. The budget and percentage levels apply to this points value.`}
                  suffix={`${context.pointsLabel} per 1 ${program.currencyCode}`}
                  max={POLICY_MAX_POINTS_RATE}
                  required
                />
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-5">
            <PanelSectionHeader
              title="Budget"
              description="The most this version can award for a single sale, shared across all levels."
            />
            <FieldGroup className="grid gap-5 sm:grid-cols-2">
              <FormPercentField
                control={form.control}
                name="budgetBps"
                label="Total reward budget"
                description={`Of the sale value, max ${formatBps(hardCapBps)}. Up to two decimals.`}
                suffix="of sale"
                required
              />
              <FormAmountField
                control={form.control}
                name="maxTotalPerEventMinor"
                label="Maximum total per sale (optional)"
                description="An absolute ceiling per sale on top of the percentage budget."
                kind="reward"
                unit={program.rewardUnit}
                currencyCode={program.currencyCode}
                minorUnits={program.currencyMinorUnits}
                emptyValue={null}
                placeholder="No limit"
              />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card id={rulesSectionId} className="scroll-mt-20">
          <CardContent className="space-y-5">
            <PanelSectionHeader
              title="Reward levels"
              description="Level 1 is the seller's direct sponsor, level 2 that sponsor's sponsor, and so on. Levels are paid in order until the budget is used up."
            />
            <FormNumberSelect
              control={form.control}
              name="maxDepth"
              label="Maximum depth"
              description={`Upline members deeper than this never receive rewards. Program limit: ${program.maxRewardDepth}.`}
              options={maxDepthOptions}
              triggerClassName="sm:max-w-48"
              required
            />
            <RulesEditor
              control={form.control}
              program={program}
              rewardFormat={rewardFmt}
              hardCapBps={hardCapBps}
            />
            <FormRadioCards
              control={form.control}
              name="ineligibleAncestorBehavior"
              label="When an upline member is not eligible"
              options={[
                {
                  value: 'FORFEIT',
                  label: 'Forfeit',
                  description: "That level's reward is not paid and stays unallocated.",
                },
                {
                  value: 'COMPRESS',
                  label: 'Compress',
                  description: 'The next eligible upline member moves up and receives that level.',
                },
              ]}
            />
            <FormSelect
              control={form.control}
              name="roundingMode"
              label="Rounding"
              description="How percentage amounts are rounded to the smallest unit."
              options={enumOptions('RoundingMode')}
              className="sm:max-w-xs"
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-5">
            <PanelSectionHeader title="Eligibility and approval" />
            <FieldGroup>
              <FormSwitch
                control={form.control}
                name="requireActiveEnrollment"
                label="Require an active, eligible enrollment for recipients"
                description="Upline members without an active, eligible enrollment in this program when the sale happens are treated as ineligible."
              />
              <ApprovalSwitch
                control={form.control}
                canAutoApprove={canAutoApprove}
                storedRequiresApproval={policy.requiresApproval}
              />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card
          id={checksId}
          role="region"
          aria-labelledby={`${checksId}-title`}
          className="scroll-mt-20"
        >
          <CardContent className="space-y-3">
            <PanelSectionHeader
              title={<span id={`${checksId}-title`}>Policy checks</span>}
              description="Run automatically as you edit. Errors block publishing; warnings don't."
              actions={
                checking ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Spinner className="size-3.5" aria-hidden />
                    Checking…
                  </span>
                ) : null
              }
            />
            {!parsed.success ? (
              <PolicyIssueList
                issues={shownIssues}
                labelFor={labelFor}
                onSelectPath={selectPath}
                announce={false}
                errorTitle="Complete these fields to run the full policy checks"
              />
            ) : validation.error ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>Couldn&apos;t run the checks: {getErrorMessage(validation.error)}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void validation.refetch()}
                >
                  <RefreshCw aria-hidden />
                  Retry
                </Button>
              </div>
            ) : validation.data ? (
              shownIssues.length === 0 ? (
                <p className="inline-flex items-center gap-1.5 text-sm text-success">
                  <CircleCheck className="size-4" aria-hidden />
                  {isDirty
                    ? 'No issues found. Save the draft to publish it.'
                    : 'No issues found — ready to publish.'}
                </p>
              ) : (
                <PolicyIssueList
                  issues={shownIssues}
                  labelFor={labelFor}
                  onSelectPath={selectPath}
                  announce={false}
                />
              )
            ) : (
              <p className="text-sm text-muted-foreground">Checking the policy…</p>
            )}
          </CardContent>
        </Card>

        <div className="sticky bottom-3 z-10 space-y-2 rounded-xl bg-card/95 p-3 shadow-sm ring-1 ring-foreground/10 backdrop-blur">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {/* The confirm dialog is rendered outside the <form>: its own submit would bubble here. */}
            <Button
              type="button"
              variant="ghost"
              className="justify-start text-destructive hover:text-destructive sm:justify-center"
              disabled={update.isPending}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 aria-hidden />
              Delete draft
            </Button>
            <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
              <p className="mr-auto text-xs text-muted-foreground sm:mr-0" aria-live="polite">
                {isDirty || approvalNeedsSave ? 'Unsaved changes' : 'All changes saved'}
                {errorCount + warningCount > 0 ? (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="underline decoration-dotted underline-offset-4 hover:decoration-solid"
                      onClick={() => scrollToElement(checksId)}
                    >
                      {errorCount > 0
                        ? `${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`
                        : null}
                      {errorCount > 0 && warningCount > 0 ? ', ' : null}
                      {warningCount > 0
                        ? `${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}`
                        : null}
                    </button>
                  </>
                ) : null}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => form.reset()}
                disabled={!isDirty || update.isPending}
              >
                <Undo2 aria-hidden />
                Discard
              </Button>
              <Button
                type="submit"
                variant={canPublish ? 'outline' : 'default'}
                disabled={!canSave}
              >
                {update.isPending ? <Spinner aria-hidden /> : <Save aria-hidden />}
                Save draft
              </Button>
              {canPublish ? (
                <Button
                  type="button"
                  onClick={openPublish}
                  disabled={isDirty || approvalNeedsSave || remoteChanged || update.isPending}
                  aria-describedby={
                    isDirty || approvalNeedsSave ? `${baseId}-publish-hint` : undefined
                  }
                >
                  <Rocket aria-hidden />
                  Publish…
                </Button>
              ) : null}
            </div>
          </div>
          {canPublish && (isDirty || approvalNeedsSave) ? (
            <p
              id={`${baseId}-publish-hint`}
              className="text-xs text-muted-foreground sm:text-right"
            >
              Save your changes before publishing.
            </p>
          ) : null}
        </div>
      </form>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        variant="destructive"
        title={`Delete draft version ${policy.version}?`}
        description="The draft and its reward levels are removed permanently. Published versions are not affected."
        confirmLabel="Delete draft"
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success(`Draft version ${policy.version} deleted`);
          onDeleted();
        }}
      />

      <DryRunPanel
        policy={policy}
        context={context}
        changes={changes}
        hasUnsavedChanges={isDirty}
      />

      {canPublish ? (
        <PublishPolicyDialog
          open={publishOpen}
          onOpenChange={setPublishOpen}
          policy={policy}
          context={context}
          versions={versions}
          openedAt={publishOpenedAt}
          onPublished={onPublished}
        />
      ) : null}
    </div>
  );
}

/**
 * "Require manual approval" — forced on (shown disabled) without `policies:auto-approve`. Not an
 * RHF-disabled field, so its value is still submitted.
 */
function ApprovalSwitch({
  control,
  canAutoApprove,
  storedRequiresApproval,
}: {
  control: PolicyControl;
  canAutoApprove: boolean;
  storedRequiresApproval: boolean;
}) {
  const {
    field: { ref: fieldRef, ...field },
  } = useController({ control, name: 'requiresApproval' });
  const id = useId();
  const description = canAutoApprove ? (
    <>
      When off, rewards from API and webhook sales are approved and posted automatically. Rewards
      from manually recorded sales always need a second person&apos;s approval.
    </>
  ) : (
    <>
      Always on for your role — only a Super Admin can let rewards be approved automatically.
      Rewards from manually recorded sales always need a second person&apos;s approval.
      {!storedRequiresApproval
        ? ' This draft was set to auto-approve; saving it will turn manual approval back on.'
        : null}
    </>
  );

  return (
    <FormItem
      id={id}
      orientation="horizontal"
      label="Require manual approval of rewards"
      description={description}
      disabled={!canAutoApprove}
    >
      <Switch
        id={id}
        name={field.name}
        ref={fieldRef}
        checked={canAutoApprove ? Boolean(field.value) : true}
        onCheckedChange={field.onChange}
        onBlur={field.onBlur}
        disabled={!canAutoApprove}
        aria-describedby={`${id}-description`}
      />
    </FormItem>
  );
}
