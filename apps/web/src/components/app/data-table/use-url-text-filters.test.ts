import { describe, expect, it } from 'vitest';

import { pendingTextPatch, reconcileTextDrafts } from './use-url-text-filters';

type Key = 'action' | 'resourceType' | 'resourceId';
const url = (v: Partial<Record<Key, string>> = {}): Record<Key, string> => ({
  action: '',
  resourceType: '',
  resourceId: '',
  ...v,
});

describe('pendingTextPatch', () => {
  it('patches only the keys the user edited, trimmed, with null to remove', () => {
    expect(pendingTextPatch(url({ resourceType: 'user' }), { action: ' reward. ' })).toEqual({ action: 'reward.' });
    expect(pendingTextPatch(url({ action: 'reward.' }), { action: '  ' })).toEqual({ action: null });
  });

  it('is null when the URL already matches every draft', () => {
    expect(pendingTextPatch(url({ action: 'reward.' }), { action: 'reward. ' })).toBeNull();
    expect(pendingTextPatch(url(), {})).toBeNull();
  });

  it('never writes back keys that were changed elsewhere (no draft for them)', () => {
    // resourceId came from a link while the user edits `action`: only `action` is patched.
    const patch = pendingTextPatch(url({ resourceId: 'abc' }), { action: 'member.' });
    expect(patch).toEqual({ action: 'member.' });
    expect(patch).not.toHaveProperty('resourceId');
  });
});

describe('reconcileTextDrafts', () => {
  it('drops drafts of keys changed outside the hook so the input shows the URL value', () => {
    const next = reconcileTextDrafts(url({ action: 'reward.' }), url({ action: 'member.' }), { action: 'reward.' }, {});
    expect(next.drafts).toEqual({});
  });

  it('keeps the draft when the URL change is the hook’s own write (the user may type on)', () => {
    const next = reconcileTextDrafts(url(), url({ action: 'rew' }), { action: 'rewa' }, { action: 'rew' });
    expect(next.drafts).toEqual({ action: 'rewa' });
    expect(next.written).toEqual({});
  });

  it('leaves drafts of keys whose URL value did not change', () => {
    const next = reconcileTextDrafts(
      url({ action: 'reward.' }),
      url({ action: 'reward.', resourceId: 'abc' }),
      { action: 'reward.app', resourceId: 'old' },
      {},
    );
    expect(next.drafts).toEqual({ action: 'reward.app' });
  });
});
