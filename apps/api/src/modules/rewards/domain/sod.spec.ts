import { describe, expect, it } from 'vitest';
import { findSodViolation, sodMessage } from './sod';

describe('findSodViolation', () => {
  const facts = { actorUserId: 'a', recipientUserId: 'r', saleRecordedById: 'x' };

  it('allows an independent reviewer', () => {
    expect(findSodViolation('approve', facts)).toBeNull();
    expect(findSodViolation('reject', facts)).toBeNull();
    expect(findSodViolation('reverse', facts)).toBeNull();
  });

  it('blocks every decision on your own reward', () => {
    for (const kind of ['approve', 'reject', 'reverse'] as const) {
      expect(findSodViolation(kind, { ...facts, actorUserId: 'r' })).toBe('OWN_REWARD');
    }
  });

  it('blocks only approvals by the recorder of the sale', () => {
    const recorder = { ...facts, actorUserId: 'x' };
    expect(findSodViolation('approve', recorder)).toBe('RECORDED_SALE');
    expect(findSodViolation('reject', recorder)).toBeNull();
    expect(findSodViolation('reverse', recorder)).toBeNull();
    expect(findSodViolation('approve', { ...facts, saleRecordedById: null })).toBeNull();
  });

  it('explains the rule', () => {
    expect(sodMessage('OWN_REWARD', 'reverse')).toMatch(/cannot reverse a reward credited to you/);
    expect(sodMessage('RECORDED_SALE', 'approve')).toMatch(/recorded this sale/);
  });
});
