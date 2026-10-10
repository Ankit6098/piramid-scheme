import { ApiClientStatus } from '@app/shared';

import type { StatusTone } from '@/lib/enum-labels';

export const API_CLIENT_STATUS_META: Record<
  ApiClientStatus,
  { label: string; tone: StatusTone; description: string }
> = {
  ACTIVE: { label: 'Active', tone: 'success', description: 'The key can submit sales' },
  REVOKED: {
    label: 'Revoked',
    tone: 'destructive-outline',
    description: 'The key is permanently disabled',
  },
};

export const API_CLIENT_STATUS_OPTIONS = ApiClientStatus.map((value) => ({
  value,
  label: API_CLIENT_STATUS_META[value].label,
}));
