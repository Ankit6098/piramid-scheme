'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  fullNameSchema,
  httpsUrlSchema,
  phoneSchema,
  type ProfileDto,
  type UpdateProfileRequest,
} from '@app/shared';

import { DateTime } from '@/components/app/date-time';
import {
  applyApiFieldErrors,
  FormTextField,
  useUnsavedChangesWarning,
} from '@/components/app/form';
import { UserAvatar } from '@/components/app/user-avatar';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage } from '@/lib/api-client';

import { useUpdateProfile } from '../api';

/** Form shape: empty strings mean "not set" and are sent as `null`. */
const profileFormSchema = z.object({
  fullName: fullNameSchema,
  phone: z.union([z.literal(''), phoneSchema]),
  avatarUrl: z.union([z.literal(''), httpsUrlSchema]),
});
type ProfileFormInput = z.input<typeof profileFormSchema>;
type ProfileFormOutput = z.output<typeof profileFormSchema>;

function toFormValues(profile: ProfileDto): ProfileFormInput {
  return {
    fullName: profile.fullName,
    phone: profile.phone ?? '',
    avatarUrl: profile.avatarUrl ?? '',
  };
}

/** Name, phone and avatar. The email address is changed from the Security tab (it needs a code). */
export function ProfileDetailsCard({ profile }: { profile: ProfileDto }) {
  const update = useUpdateProfile();
  const form = useForm<ProfileFormInput, unknown, ProfileFormOutput>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: toFormValues(profile),
  });
  useUnsavedChangesWarning(form);
  const { reset } = form;
  useEffect(() => {
    reset(toFormValues(profile));
  }, [profile, reset]);
  const avatarPreview = useWatch({ control: form.control, name: 'avatarUrl' });
  const namePreview = useWatch({ control: form.control, name: 'fullName' });

  const onSubmit = form.handleSubmit((values) => {
    const body: UpdateProfileRequest = {
      fullName: values.fullName,
      phone: values.phone === '' ? null : values.phone,
      avatarUrl: values.avatarUrl === '' ? null : values.avatarUrl,
    };
    update.mutate(body, {
      onSuccess: () => toast.success('Profile saved'),
      onError: (error) => {
        if (!applyApiFieldErrors(error, form.setError))
          toast.error("Couldn't save your profile", { description: getErrorMessage(error) });
      },
    });
  });

  const avatarSrc =
    !form.formState.errors.avatarUrl && avatarPreview?.startsWith('https://')
      ? avatarPreview
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Personal details</CardTitle>
        <CardDescription>
          Your name is shown to your sponsor and team as first name and last initial only.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="space-y-6">
          <div className="flex items-center gap-4">
            <UserAvatar name={namePreview || profile.fullName} src={avatarSrc} size="lg" />
            <div className="min-w-0 text-sm">
              <p className="truncate font-medium">{profile.email}</p>
              <p className="text-muted-foreground">
                Member since <DateTime value={profile.createdAt} style="date" />
              </p>
            </div>
          </div>
          <FieldGroup>
            <FormTextField
              control={form.control}
              name="fullName"
              label="Full name"
              autoComplete="name"
              required
            />
            <FormTextField
              control={form.control}
              name="phone"
              label="Phone (optional)"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              placeholder="+91 98765 43210"
              description="International format. Never shown to other members."
            />
            <FormTextField
              control={form.control}
              name="avatarUrl"
              label="Avatar image URL (optional)"
              type="url"
              inputMode="url"
              placeholder="https://"
              description="A secure https:// link to a square image."
            />
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-6 justify-end gap-2 border-t pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={!form.formState.isDirty || update.isPending}
            onClick={() => reset(toFormValues(profile))}
          >
            Discard
          </Button>
          <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
            {update.isPending ? <Spinner /> : null}
            Save changes
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
