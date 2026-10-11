'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useController, useForm, useWatch, type Control } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  isValidTimeZone,
  PROGRAM_CODE_PATTERN,
  programDateIssues,
  type AdminProgramDetailDto,
  type CreateProgramInput,
  type ProgramEditableField,
  type UpdateProgramInput,
} from '@app/shared';

import {
  FormDateTimeField,
  FormSelect,
  FormSwitch,
  FormTextarea,
  FormTextField,
  applyApiFieldErrors,
  useUnsavedChangesWarning,
} from '@/components/app/form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { useBrowserTimeZone } from '@/hooks/use-time-zone';
import { getErrorMessage } from '@/lib/api-client';
import { enumLabel } from '@/lib/enum-labels';
import { usePlatformSettings } from '@/providers/platform-settings-provider';

import { useCreateProgram, useOfferingChoices, useUpdateProgram } from '../../api';
import { programHref } from './program-links';

const COMMON_ZONES = [
  'Asia/Kolkata',
  'UTC',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Kathmandu',
  'Asia/Colombo',
  'Asia/Dhaka',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Toronto',
];

const intString = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, 'Use a whole number')
    .refine((v) => Number(v) >= min && Number(v) <= max, message);

const schema = z
  .object({
    name: z.string().trim().min(2, 'Enter at least 2 characters').max(160),
    code: z
      .string()
      .trim()
      .min(3, 'Use at least 3 characters')
      .max(64)
      .regex(PROGRAM_CODE_PATTERN, 'Lowercase letters, digits and single hyphens (e.g. spring-2027)'),
    offeringId: z.string().min(1, 'Choose an offering'),
    description: z.string().trim().max(5000),
    timezone: z.string().refine(isValidTimeZone, 'Choose a valid time zone'),
    startsAt: z.string().min(1, 'Choose when the program starts'),
    endsAt: z.string().nullable(),
    enrollmentOpensAt: z.string().nullable(),
    enrollmentClosesAt: z.string().nullable(),
    maxRewardDepth: intString(1, 10, 'Between 1 and 10 levels'),
    lateEventGraceDays: intString(0, 365, 'Between 0 and 365 days'),
    minAccountAgeDays: z.union([z.literal(''), intString(0, 3650, 'Between 0 and 3650 days')]),
    requireSponsor: z.boolean(),
    termsVersion: z.string().trim().min(1, 'Enter a terms version').max(32),
    termsText: z.string().trim().max(50_000),
  })
  .superRefine((v, ctx) => {
    if (!v.startsAt) return;
    for (const issue of programDateIssues({ ...v, enrollmentOpensAt: v.enrollmentOpensAt ?? v.startsAt })) {
      ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    }
  });
type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function toFormValues(p: AdminProgramDetailDto): FormInput {
  return {
    name: p.name,
    code: p.code,
    offeringId: p.offering.id,
    description: p.description ?? '',
    timezone: p.timezone,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    enrollmentOpensAt: p.enrollmentOpensAt,
    enrollmentClosesAt: p.enrollmentClosesAt,
    maxRewardDepth: String(p.maxRewardDepth),
    lateEventGraceDays: String(p.lateEventGraceDays),
    minAccountAgeDays: p.eligibility.minAccountAgeDays !== undefined ? String(p.eligibility.minAccountAgeDays) : '',
    requireSponsor: p.eligibility.requireSponsor ?? false,
    termsVersion: p.termsVersion,
    termsText: p.termsText ?? '',
  };
}

function eligibilityOf(v: FormOutput) {
  return {
    ...(v.minAccountAgeDays !== '' && Number(v.minAccountAgeDays) > 0 ? { minAccountAgeDays: Number(v.minAccountAgeDays) } : {}),
    ...(v.requireSponsor ? { requireSponsor: true } : {}),
  };
}

const sameInstant = (a: string | null, b: string | null) => (a ? Date.parse(a) : null) === (b ? Date.parse(b) : null);

/** Changed + editable fields only (the API rejects locked fields even when unchanged values are sent). */
function buildPatch(p: AdminProgramDetailDto, v: FormOutput): Omit<UpdateProgramInput, 'expectedVersion'> {
  const editable = new Set<ProgramEditableField>(p.editableFields);
  const patch: Omit<UpdateProgramInput, 'expectedVersion'> = {};
  const put = <K extends ProgramEditableField>(key: K, changed: boolean, value: unknown) => {
    if (changed && editable.has(key)) (patch as Record<string, unknown>)[key] = value;
  };
  put('name', v.name !== p.name, v.name);
  put('code', v.code !== p.code, v.code);
  put('offeringId', v.offeringId !== p.offering.id, v.offeringId);
  put('description', (v.description || null) !== p.description, v.description || null);
  put('timezone', v.timezone !== p.timezone, v.timezone);
  put('startsAt', !sameInstant(v.startsAt, p.startsAt), v.startsAt);
  put('endsAt', !sameInstant(v.endsAt, p.endsAt), v.endsAt);
  const opens = v.enrollmentOpensAt ?? v.startsAt;
  put('enrollmentOpensAt', !sameInstant(opens, p.enrollmentOpensAt), opens);
  put('enrollmentClosesAt', !sameInstant(v.enrollmentClosesAt, p.enrollmentClosesAt), v.enrollmentClosesAt);
  put('maxRewardDepth', Number(v.maxRewardDepth) !== p.maxRewardDepth, Number(v.maxRewardDepth));
  put('lateEventGraceDays', Number(v.lateEventGraceDays) !== p.lateEventGraceDays, Number(v.lateEventGraceDays));
  const eligibility = eligibilityOf(v);
  const current = {
    ...(p.eligibility.minAccountAgeDays ? { minAccountAgeDays: p.eligibility.minAccountAgeDays } : {}),
    ...(p.eligibility.requireSponsor ? { requireSponsor: true } : {}),
  };
  put('eligibility', JSON.stringify(eligibility) !== JSON.stringify(current), eligibility);
  put('termsVersion', v.termsVersion !== p.termsVersion, v.termsVersion);
  put('termsText', (v.termsText || null) !== p.termsText, v.termsText || null);
  return patch;
}

export interface ProgramFormProps {
  /** Edit this program; omit to create a new DRAFT. */
  program?: AdminProgramDetailDto;
}

/** Defaults of the create form (also restored after a successful create). */
const EMPTY_VALUES: FormInput = {
  name: '',
  code: '',
  offeringId: '',
  description: '',
  timezone: 'Asia/Kolkata',
  startsAt: '',
  endsAt: null,
  enrollmentOpensAt: null,
  enrollmentClosesAt: null,
  maxRewardDepth: '5',
  lateEventGraceDays: '30',
  minAccountAgeDays: '',
  requireSponsor: false,
  termsVersion: '1.0',
  termsText: '',
};

/**
 * Sectioned program form with validation, locked-field hints and an unsaved-changes guard.
 *
 * Edit mode: render it with `key={program.version}` so a new version (this admin's save, or another
 * admin's change picked up by a refetch) starts a fresh form; `expectedVersion` is always the
 * version the form was mounted with, so a concurrent change still fails with STALE_VERSION.
 */
export function ProgramForm({ program }: ProgramFormProps) {
  const router = useRouter();
  const browserZone = useBrowserTimeZone();
  const { settings } = usePlatformSettings();
  const offerings = useOfferingChoices();
  const create = useCreateProgram();
  const update = useUpdateProgram(program?.id ?? '');
  const pending = create.isPending || update.isPending;
  const editable = useMemo(() => new Set<ProgramEditableField>(program ? program.editableFields : []), [program]);
  const locked = (field: ProgramEditableField) => Boolean(program) && !editable.has(field);

  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: program ? toFormValues(program) : EMPTY_VALUES,
  });
  useUnsavedChangesWarning(form);
  const timezone = useWatch({ control: form.control, name: 'timezone' });
  const zone = isValidTimeZone(timezone) ? timezone : 'UTC';

  // Suggest a code from the name until the admin edits the code (create only).
  const name = useWatch({ control: form.control, name: 'name' });
  const [codeTouched, setCodeTouched] = useState(false);
  useEffect(() => {
    if (program || codeTouched) return;
    form.setValue('code', slugify(name), { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  }, [name, program, codeTouched, form]);

  const zoneOptions = useMemo(() => {
    const zones = new Set(COMMON_ZONES);
    if (browserZone) zones.add(browserZone);
    if (program) zones.add(program.timezone);
    return [...zones].map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
  }, [browserZone, program]);

  const offeringOptions = useMemo(() => {
    const options = (offerings.data ?? []).map((o) => ({
      value: o.id,
      label: o.status === 'ACTIVE' ? o.name : `${o.name} — not approved yet`,
    }));
    // Keep the program's own offering selectable even if it is not among the newest offerings.
    if (program && !options.some((o) => o.value === program.offering.id)) {
      options.unshift({ value: program.offering.id, label: program.offering.name });
    }
    return options;
  }, [offerings.data, program]);

  async function onSubmit(values: FormOutput) {
    try {
      if (program) {
        const patch = buildPatch(program, values);
        if (Object.keys(patch).length === 0) {
          toast.info('No changes to save');
          return;
        }
        const updated = await update.mutateAsync({ expectedVersion: program.version, ...patch });
        toast.success('Program updated');
        // Saved: not dirty any more (stops the unsaved-changes guard), showing what the server stored.
        form.reset(toFormValues(updated));
        router.push(programHref(program.id));
      } else {
        const input: CreateProgramInput = {
          code: values.code,
          name: values.name,
          offeringId: values.offeringId,
          description: values.description || null,
          timezone: values.timezone,
          startsAt: values.startsAt,
          endsAt: values.endsAt,
          enrollmentOpensAt: values.enrollmentOpensAt ?? values.startsAt,
          enrollmentClosesAt: values.enrollmentClosesAt,
          maxRewardDepth: Number(values.maxRewardDepth),
          lateEventGraceDays: Number(values.lateEventGraceDays),
          eligibility: eligibilityOf(values),
          termsVersion: values.termsVersion,
          termsText: values.termsText || null,
        };
        const created = await create.mutateAsync(input);
        toast.success('Draft program created', { description: 'Add options and a reward policy, then publish it.' });
        // The /new route stays mounted (hidden) after navigating: start the next program from scratch.
        form.reset(EMPTY_VALUES);
        setCodeTouched(false);
        router.push(programHref(created.id));
      }
    } catch (error) {
      if (!applyApiFieldErrors(error, form)) {
        toast.error(program ? 'Couldn’t save the program' : 'Couldn’t create the program', { description: getErrorMessage(error) });
      }
    }
  }

  const unit = program ? program.rewardUnit : settings?.rewardUnit;
  const currency = program ? program.currencyCode : settings?.currencyCode;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      {program && program.status !== 'DRAFT' ? (
        <p className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          This program is {enumLabel('ProgramStatus', program.status).toLowerCase()}. Code, offering, reward depth and other structural
          fields are locked; only the fields that can still change are editable.
        </p>
      ) : null}

      <Section title="Basics" description="What members see, and the approved offering whose sales can earn rewards.">
        <FieldGroup className="grid gap-4 md:grid-cols-2">
          <FormTextField control={form.control} name="name" label="Program name" maxLength={160} required disabled={locked('name')} />
          <CodeField control={form.control} disabled={locked('code')} onTouched={() => setCodeTouched(true)} />
          <FormSelect
            control={form.control}
            name="offeringId"
            label="Offering"
            options={offeringOptions}
            placeholder={offerings.isPending ? 'Loading offerings…' : 'Choose an offering'}
            description={
              locked('offeringId')
                ? 'Locked after publication.'
                : 'Publishing requires an approved offering. Rewards only come from its qualifying sales.'
            }
            required
            disabled={locked('offeringId')}
            className="md:col-span-2"
          />
          <FormTextarea
            control={form.control}
            name="description"
            label="Description"
            rows={4}
            maxLength={5000}
            showCount
            disabled={locked('description')}
            className="md:col-span-2"
          />
        </FieldGroup>
      </Section>

      <Section title="Schedule" description="Dates are entered and displayed in the program time zone and stored in UTC.">
        <FieldGroup className="grid gap-4 md:grid-cols-2">
          <FormSelect
            control={form.control}
            name="timezone"
            label="Time zone"
            options={zoneOptions}
            required
            disabled={locked('timezone')}
            className="md:col-span-2"
          />
          <FormDateTimeField control={form.control} name="startsAt" label="Starts" timeZone={zone} required disabled={locked('startsAt')} />
          <FormDateTimeField
            control={form.control}
            name="endsAt"
            label="Ends"
            timeZone={zone}
            emptyValue={null}
            description="Optional. The program completes automatically at this time."
            disabled={locked('endsAt')}
          />
          <FormDateTimeField
            control={form.control}
            name="enrollmentOpensAt"
            label="Enrollment opens"
            timeZone={zone}
            emptyValue={null}
            description="Leave empty to open enrollment when the program starts."
            disabled={locked('enrollmentOpensAt')}
          />
          <FormDateTimeField
            control={form.control}
            name="enrollmentClosesAt"
            label="Enrollment closes"
            timeZone={zone}
            emptyValue={null}
            description="Optional. Must be on or before the program end."
            disabled={locked('enrollmentClosesAt')}
          />
        </FieldGroup>
      </Section>

      <Section
        title="Reward structure"
        description={
          unit && currency
            ? `Rewards in this program are in ${unit === 'POINTS' ? 'points' : 'money'} and prices in ${currency}${program ? '' : ' (copied from the platform settings when the program is created)'}.`
            : 'The reward unit and currency are copied from the platform settings when the program is created.'
        }
      >
        <FieldGroup className="grid gap-4 md:grid-cols-2">
          <FormTextField
            control={form.control}
            name="maxRewardDepth"
            label="Maximum reward depth"
            inputMode="numeric"
            description="Upline levels a reward policy may pay (1–10). Locked after publication."
            required
            disabled={locked('maxRewardDepth')}
          />
          <FormTextField
            control={form.control}
            name="lateEventGraceDays"
            label="Late sale grace period (days)"
            inputMode="numeric"
            description="Sales that happened before the end may still be recorded this many days later."
            required
            disabled={locked('lateEventGraceDays')}
          />
        </FieldGroup>
      </Section>

      <Section title="Eligibility" description="Extra conditions a member must meet to enroll.">
        <FieldGroup className="grid gap-4 md:grid-cols-2">
          <FormTextField
            control={form.control}
            name="minAccountAgeDays"
            label="Minimum account age (days)"
            inputMode="numeric"
            placeholder="No minimum"
            disabled={locked('eligibility')}
          />
          <FormSwitch
            control={form.control}
            name="requireSponsor"
            label="Referred members only"
            description="Only members who joined through a referral link can enroll."
            disabled={locked('eligibility')}
          />
        </FieldGroup>
      </Section>

      <Section
        title="Terms"
        description={
          program && program.status !== 'DRAFT'
            ? 'Members accept these terms when they enroll. Changing the text requires a new version; existing enrollments keep the version they accepted.'
            : 'Members accept these terms when they enroll.'
        }
      >
        <FieldGroup className="grid gap-4">
          <FormTextField
            control={form.control}
            name="termsVersion"
            label="Terms version"
            maxLength={32}
            className="sm:max-w-48"
            required
            disabled={locked('termsVersion')}
          />
          <FormTextarea control={form.control} name="termsText" label="Terms" rows={8} maxLength={50_000} disabled={locked('termsText')} />
        </FieldGroup>
      </Section>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-col-reverse gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" asChild>
          <Link href={program ? programHref(program.id) : '/admin/programs'}>Cancel</Link>
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner aria-hidden /> : null}
          {program ? 'Save changes' : 'Create draft'}
        </Button>
      </div>
    </form>
  );
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function CodeField({
  control,
  disabled,
  onTouched,
}: {
  control: Control<FormInput, unknown, FormOutput>;
  disabled: boolean;
  onTouched: () => void;
}) {
  const { field } = useController({ control, name: 'code' });
  return (
    <div onInput={onTouched}>
      <FormTextField
        control={control}
        name="code"
        label="Code"
        description={disabled ? 'Locked after publication.' : `Unique slug used in links, e.g. /programs/${field.value || 'spring-2027'}.`}
        maxLength={64}
        autoComplete="off"
        spellCheck={false}
        required
        disabled={disabled}
      />
    </div>
  );
}
