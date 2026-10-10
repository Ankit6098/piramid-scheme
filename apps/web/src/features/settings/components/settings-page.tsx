'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Coins, Info, Lock, Landmark, RotateCcw, Save, ShieldCheck, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useController, useForm, useWatch, type Control } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  decimalToMinor,
  formatBps,
  minorToDecimalString,
  PLATFORM_SETTINGS_LIMITS,
  RewardUnit,
  SUPPORTED_CURRENCIES,
  type CurrencyDto,
  type PlatformSettingsDto,
  type UpdatePlatformSettingsInput,
} from '@app/shared';

import { Amount } from '@/components/app/amount';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { ErrorState } from '@/components/app/error-state';
import { FormTextField, applyApiFieldErrors, useUnsavedChangesWarning } from '@/components/app/form';
import { PageHeader } from '@/components/app/page-header';
import { RelativeTime } from '@/components/app/date-time';
import { FormSkeleton } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { isApiError } from '@/lib/api-client';

import { useAdminSettings, useCurrencies, useUpdateSettings } from '../api';

const L = PLATFORM_SETTINGS_LIMITS;

/** Percent with up to 2 decimals → basis points (exact, no floats). "12.5" → 1250. */
function percentToBps(value: string): number | null {
  const bps = decimalToMinor(value.trim(), 2);
  return bps === null ? null : Number(bps);
}

const formSchema = z.object({
  rewardUnit: z.enum(RewardUnit),
  currencyCode: z.string().regex(/^[A-Z]{3}$/, 'Choose a currency'),
  pointsLabel: z.string().trim().min(1, 'Enter a label for points').max(L.pointsLabelMaxLength),
  pointsPerCurrencyUnit: z
    .string()
    .trim()
    .regex(/^\d+$/, 'Use a whole number')
    .refine((v) => Number(v) >= L.pointsPerCurrencyUnitMin && Number(v) <= L.pointsPerCurrencyUnitMax, {
      message: `Between ${L.pointsPerCurrencyUnitMin} and ${L.pointsPerCurrencyUnitMax.toLocaleString('en-IN')}`,
    }),
  budgetPercent: z
    .string()
    .trim()
    .refine((v) => percentToBps(v) !== null, 'Use a percentage with up to 2 decimals')
    .refine((v) => {
      const bps = percentToBps(v);
      return bps === null || (bps >= L.defaultRewardBudgetBpsMin && bps <= L.defaultRewardBudgetBpsMax);
    }, 'Between 0.01% and 50% — rewards can never exceed half of a sale'),
});
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

function toFormValues(s: PlatformSettingsDto): FormInput {
  return {
    rewardUnit: s.rewardUnit,
    currencyCode: s.currencyCode,
    pointsLabel: s.pointsLabel,
    pointsPerCurrencyUnit: String(s.pointsPerCurrencyUnit),
    budgetPercent: minorToDecimalString(s.defaultRewardBudgetBps, 2).replace(/\.?0+$/, ''),
  };
}

type Changes = Omit<UpdatePlatformSettingsInput, 'expectedVersion' | 'reason'>;

function diff(s: PlatformSettingsDto, v: FormOutput): Changes {
  const changes: Changes = {};
  if (v.rewardUnit !== s.rewardUnit) changes.rewardUnit = v.rewardUnit;
  if (v.currencyCode !== s.currencyCode) changes.currencyCode = v.currencyCode;
  if (v.pointsLabel !== s.pointsLabel) changes.pointsLabel = v.pointsLabel;
  const rate = Number(v.pointsPerCurrencyUnit);
  if (rate !== s.pointsPerCurrencyUnit) changes.pointsPerCurrencyUnit = rate;
  const bps = percentToBps(v.budgetPercent);
  if (bps !== null && bps !== s.defaultRewardBudgetBps) changes.defaultRewardBudgetBps = bps;
  return changes;
}

const UNIT_COPY: Record<RewardUnit, { title: string; description: string; icon: typeof Landmark }> = {
  MONEY: {
    title: 'Money',
    description: 'Rewards are amounts in the platform currency, recorded as liabilities in the ledger.',
    icon: Landmark,
  },
  POINTS: {
    title: 'Points',
    description: 'Rewards are non-cash points. Each policy converts the sale value into points at its own rate.',
    icon: Sparkles,
  },
};

/** /admin/settings — platform reward unit, currency, points and policy defaults (SUPER_ADMIN). */
export function SettingsPage() {
  const settingsQuery = useAdminSettings();
  if (settingsQuery.isPending) {
    return (
      <div>
        <PageHeader title="Platform settings" description="Reward unit, currency and defaults for the whole platform." />
        <Card className="px-4">
          <FormSkeleton fields={6} />
        </Card>
      </div>
    );
  }
  if (settingsQuery.error || !settingsQuery.data) {
    return (
      <div>
        <PageHeader title="Platform settings" />
        <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />
      </div>
    );
  }
  // Re-mount the form when another admin's change arrives (new version) so defaults stay in sync.
  return <SettingsForm key={settingsQuery.data.version} settings={settingsQuery.data} onReload={() => void settingsQuery.refetch()} />;
}

function SettingsForm({ settings, onReload }: { settings: PlatformSettingsDto; onReload: () => void }) {
  const currenciesQuery = useCurrencies();
  const currencies: readonly CurrencyDto[] = currenciesQuery.data ?? SUPPORTED_CURRENCIES;
  const update = useUpdateSettings();
  const [confirm, setConfirm] = useState<{ changes: Changes } | null>(null);

  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: toFormValues(settings),
  });
  useUnsavedChangesWarning(form);
  const values = useWatch({ control: form.control }) as FormInput;

  const lockedCurrencies = settings.liveProgramCurrencyCodes;
  const allowedCurrency = (code: string) =>
    lockedCurrencies.length === 0 || (lockedCurrencies.length === 1 && lockedCurrencies[0] === code) || code === settings.currencyCode;

  /**
   * Validates and opens the review dialog. Deliberately not `handleSubmit`: that would mark the form
   * as successfully submitted and switch off the unsaved-changes guard before anything is saved.
   */
  async function review() {
    if (!(await form.trigger())) {
      form.setFocus(
        (Object.keys(form.formState.errors)[0] as keyof FormInput | undefined) ?? 'pointsLabel',
      );
      return;
    }
    const parsed = formSchema.safeParse(form.getValues());
    if (!parsed.success) return;
    const changes = diff(settings, parsed.data);
    if (Object.keys(changes).length === 0) {
      toast.info('Nothing to save — the settings are unchanged.');
      return;
    }
    setConfirm({ changes });
  }

  async function save(reason: string | undefined) {
    if (!confirm || !reason) return;
    try {
      const saved = await update.mutateAsync({ expectedVersion: settings.version, reason, ...confirm.changes });
      form.reset(toFormValues(saved));
      toast.success('Platform settings saved', { description: 'The new display format applies across the platform.' });
    } catch (error) {
      if (isApiError(error) && error.code === 'STALE_VERSION') {
        setConfirm(null);
        toast.error('Someone else changed the settings', {
          description: 'Reload to see the latest values, then apply your change again.',
          action: { label: 'Reload', onClick: onReload },
        });
        return;
      }
      if (applyApiFieldErrors(error, form.setError)) setConfirm(null);
      throw error;
    }
  }

  const currencyName = (code: string) => currencies.find((c) => c.code === code)?.name ?? code;
  const minorUnits = currencies.find((c) => c.code === values.currencyCode)?.minorUnits ?? settings.currencyMinorUnits;

  return (
    <div>
      <PageHeader
        title="Platform settings"
        description="Choose whether rewards are paid in money or points, and the currency the platform uses for prices and sales. Every change is audited."
        meta={
          settings.updatedBy ? (
            <span className="text-xs text-muted-foreground">
              Last changed by {settings.updatedBy.fullName} <RelativeTime value={settings.updatedAt} />
            </span>
          ) : null
        }
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void review();
        }}
        noValidate
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Reward unit</CardTitle>
                <CardDescription>
                  The default for new programs and how platform-wide totals are shown. Existing programs keep the unit they were created
                  with, and every reward is always displayed in its own unit.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RewardUnitField control={form.control} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Currency</CardTitle>
                <CardDescription>
                  Used for option prices and sale amounts, and for rewards in money mode. New programs copy it when they are created.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <CurrencyField
                  control={form.control}
                  currencies={currencies}
                  isAllowed={allowedCurrency}
                  error={form.formState.errors.currencyCode?.message}
                />
                {lockedCurrencies.length > 0 ? (
                  <Alert>
                    <Lock aria-hidden />
                    <AlertTitle>Currency changes are limited</AlertTitle>
                    <AlertDescription>
                      {settings.liveProgramCount} live program{settings.liveProgramCount === 1 ? '' : 's'} use{' '}
                      {lockedCurrencies.join(', ')}. The platform currency can only change once no scheduled, active or paused program uses a
                      different currency.
                    </AlertDescription>
                  </Alert>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Points</CardTitle>
                <CardDescription>
                  How points are named, and the default conversion copied into new reward policy drafts (each policy keeps its own rate
                  once published).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid gap-4 sm:grid-cols-2">
                  <FormTextField
                    control={form.control}
                    name="pointsLabel"
                    label="Points label"
                    description="Shown next to point amounts, e.g. “1,200 Points”."
                    maxLength={L.pointsLabelMaxLength}
                    required
                  />
                  <FormTextField
                    control={form.control}
                    name="pointsPerCurrencyUnit"
                    label="Default points per currency unit"
                    description={`Points earned per 1 ${values.currencyCode || settings.currencyCode} of sale value.`}
                    inputMode="numeric"
                    required
                  />
                </FieldGroup>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Reward policy defaults</CardTitle>
                <CardDescription>
                  The total reward budget suggested for new policy drafts, as a share of each qualifying sale. The platform caps every
                  policy and every calculation at 50% of the sale.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FormTextField
                  control={form.control}
                  name="budgetPercent"
                  label="Default reward budget"
                  endAddon="%"
                  inputMode="decimal"
                  className="sm:max-w-64"
                  description="Between 0.01% and 50%."
                  required
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
                  Payouts
                </CardTitle>
                <CardDescription>Real-money payouts are not available on this platform.</CardDescription>
              </CardHeader>
              <CardContent>
                <Field orientation="horizontal" data-disabled>
                  <FieldContent>
                    <FieldTitle id="payouts-label">
                      Payouts <Lock className="size-3.5 text-muted-foreground" aria-hidden />
                    </FieldTitle>
                    <FieldDescription>
                      Rewards are recorded as liabilities in the ledger only. Enabling payouts requires legal, KYC and payment-provider
                      approval and a reviewed database change — it cannot be switched on here.
                    </FieldDescription>
                  </FieldContent>
                  <Switch checked={false} disabled aria-labelledby="payouts-label" aria-describedby="payouts-state" />
                  <span id="payouts-state" className="sr-only">
                    Off, locked
                  </span>
                </Field>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            <FormattingPreview
              rewardUnit={values.rewardUnit ?? settings.rewardUnit}
              currencyCode={values.currencyCode || settings.currencyCode}
              currencyName={currencyName(values.currencyCode || settings.currencyCode)}
              minorUnits={minorUnits}
              pointsLabel={values.pointsLabel?.trim() || settings.pointsLabel}
              pointsRate={/^\d+$/.test(values.pointsPerCurrencyUnit ?? '') ? Number(values.pointsPerCurrencyUnit) : settings.pointsPerCurrencyUnit}
              budgetBps={percentToBps(values.budgetPercent ?? '') ?? settings.defaultRewardBudgetBps}
            />
            <Card size="sm">
              <CardContent className="flex flex-col gap-2">
                <Button type="submit" disabled={update.isPending}>
                  <Save aria-hidden />
                  Review and save
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!form.formState.isDirty || update.isPending}
                  onClick={() => form.reset(toFormValues(settings))}
                >
                  <RotateCcw aria-hidden />
                  Discard changes
                </Button>
                <p className="text-xs text-muted-foreground">You’ll be asked for a reason. It is stored in the audit log.</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </form>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title="Save platform settings?"
        description="These changes apply across the platform immediately. Programs that already exist keep their own unit and currency."
        confirmLabel="Save settings"
        reason={{ label: 'Reason for the change', placeholder: 'e.g. Switching to points for the regional pilot' }}
        onConfirm={({ reason }) => save(reason)}
      >
        {confirm ? <ChangeSummary settings={settings} changes={confirm.changes} currencyName={currencyName} /> : null}
      </ConfirmDialog>
    </div>
  );
}

function RewardUnitField({ control }: { control: Control<FormInput, unknown, FormOutput> }) {
  const { field } = useController({ control, name: 'rewardUnit' });
  return (
    <RadioGroup
      value={field.value}
      onValueChange={(next) => field.onChange(next as RewardUnit)}
      name={field.name}
      className="grid gap-3 sm:grid-cols-2"
      aria-label="Reward unit"
    >
      {RewardUnit.map((unit) => {
        const copy = UNIT_COPY[unit];
        const Icon = copy.icon;
        return (
          <FieldLabel key={unit} htmlFor={`reward-unit-${unit}`}>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>
                  <Icon className="size-4 text-muted-foreground" aria-hidden />
                  {copy.title}
                </FieldTitle>
                <FieldDescription>{copy.description}</FieldDescription>
              </FieldContent>
              <RadioGroupItem value={unit} id={`reward-unit-${unit}`} />
            </Field>
          </FieldLabel>
        );
      })}
    </RadioGroup>
  );
}

function CurrencyField({
  control,
  currencies,
  isAllowed,
  error,
}: {
  control: Control<FormInput, unknown, FormOutput>;
  currencies: readonly CurrencyDto[];
  isAllowed: (code: string) => boolean;
  error?: string;
}) {
  const { field } = useController({ control, name: 'currencyCode' });
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor="currency-code">Platform currency</FieldLabel>
      <Select value={field.value} onValueChange={field.onChange} name={field.name}>
        <SelectTrigger id="currency-code" className="w-full sm:w-80" aria-invalid={error ? true : undefined}>
          <SelectValue placeholder="Choose a currency" />
        </SelectTrigger>
        <SelectContent position="popper">
          {currencies.map((c) => (
            <SelectItem key={c.code} value={c.code} disabled={!isAllowed(c.code)}>
              <span className="font-mono text-xs">{c.code}</span>
              <span>{c.name}</span>
              <span className="text-xs text-muted-foreground">
                {c.minorUnits === 0 ? 'no decimals' : `${c.minorUnits} decimals`}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>Amounts are stored as whole minor units (for example paise or cents), never as decimals.</FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

function FormattingPreview({
  rewardUnit,
  currencyCode,
  currencyName,
  minorUnits,
  pointsLabel,
  pointsRate,
  budgetBps,
}: {
  rewardUnit: RewardUnit;
  currencyCode: string;
  currencyName: string;
  minorUnits: number;
  pointsLabel: string;
  pointsRate: number;
  budgetBps: number;
}) {
  // Sample sale of 1,000 major units, computed in integer minor units (bigint, no floats).
  const scale = BigInt(10) ** BigInt(minorUnits);
  const sale = BigInt(1000) * scale;
  const price = BigInt(499) * scale;
  const moneyBudget = (sale * BigInt(budgetBps)) / BigInt(10_000);
  const points = BigInt(1000) * BigInt(pointsRate);
  const pointsBudget = (points * BigInt(budgetBps)) / BigInt(10_000);
  const currency = { currencyCode, minorUnits };
  const rewardFormat =
    rewardUnit === 'POINTS'
      ? { unit: 'POINTS' as const, currencyCode, minorUnits: 0, pointsLabel }
      : { unit: 'MONEY' as const, currencyCode, minorUnits, pointsLabel };

  return (
    <Card size="sm" aria-live="polite">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="size-4 text-muted-foreground" aria-hidden />
          Live preview
        </CardTitle>
        <CardDescription>How amounts will look with these settings.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <PreviewRow label="Currency">
          {currencyCode} · {currencyName}
        </PreviewRow>
        <PreviewRow label="A plan price">
          <Amount kind="currency" value={price} format={currency} />
        </PreviewRow>
        <PreviewRow label="A sale">
          <Amount kind="currency" value={sale} format={currency} />
        </PreviewRow>
        <PreviewRow label="A reward">
          <Amount value={rewardUnit === 'POINTS' ? BigInt(1250) : BigInt(150) * scale} format={rewardFormat} />
        </PreviewRow>
        <Separator />
        <div className="flex gap-2 rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <p>
            With a {formatBps(budgetBps)} budget, a sale of <Amount kind="currency" value={sale} format={currency} /> can fund at most{' '}
            {rewardUnit === 'POINTS' ? (
              <>
                <Amount value={pointsBudget} format={rewardFormat} /> (from <Amount value={points} format={rewardFormat} /> at {pointsRate}{' '}
                per {currencyCode})
              </>
            ) : (
              <Amount value={moneyBudget} format={rewardFormat} />
            )}{' '}
            in rewards across all levels. Rewards only ever come from qualifying sales of approved offerings.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function PreviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

function ChangeSummary({
  settings,
  changes,
  currencyName,
}: {
  settings: PlatformSettingsDto;
  changes: Changes;
  currencyName: (code: string) => string;
}) {
  const rows = useMemo(() => {
    const list: Array<{ label: string; from: string; to: string }> = [];
    if (changes.rewardUnit) list.push({ label: 'Reward unit', from: UNIT_COPY[settings.rewardUnit].title, to: UNIT_COPY[changes.rewardUnit].title });
    if (changes.currencyCode) {
      list.push({
        label: 'Currency',
        from: `${settings.currencyCode} (${currencyName(settings.currencyCode)})`,
        to: `${changes.currencyCode} (${currencyName(changes.currencyCode)})`,
      });
    }
    if (changes.pointsLabel) list.push({ label: 'Points label', from: settings.pointsLabel, to: changes.pointsLabel });
    if (changes.pointsPerCurrencyUnit !== undefined) {
      list.push({ label: 'Default points rate', from: String(settings.pointsPerCurrencyUnit), to: String(changes.pointsPerCurrencyUnit) });
    }
    if (changes.defaultRewardBudgetBps !== undefined) {
      list.push({ label: 'Default budget', from: formatBps(settings.defaultRewardBudgetBps), to: formatBps(changes.defaultRewardBudgetBps) });
    }
    return list;
  }, [settings, changes, currencyName]);

  return (
    <div className="space-y-3">
      <dl className="divide-y rounded-lg border">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[8rem_1fr] gap-2 px-3 py-2">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd>
              <span className="text-muted-foreground line-through">{r.from}</span> → <span className="font-medium">{r.to}</span>
            </dd>
          </div>
        ))}
      </dl>
      {changes.currencyCode || changes.rewardUnit ? (
        <p className="text-xs text-muted-foreground">
          New programs will use the new {changes.currencyCode && changes.rewardUnit ? 'unit and currency' : changes.currencyCode ? 'currency' : 'unit'}.
          Existing programs, prices and rewards keep the values they were created with.
        </p>
      ) : null}
    </div>
  );
}
