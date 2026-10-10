import { describe, expect, it } from 'vitest';
import { evaluateSponsorCorrection, type CorrectionFacts } from './correction-rules';

const base: CorrectionFacts = {
  memberId: 'm',
  performerId: 'admin',
  currentSponsorId: 'old',
  newSponsor: { id: 'new', status: 'ACTIVE', emailVerified: true },
  newSponsorInMemberSubtree: false,
  performerIsUplineOfNewSponsor: false,
  receivedEventCount: 0,
};
const codes = (f: Partial<CorrectionFacts>) => evaluateSponsorCorrection({ ...base, ...f }).map((i) => i.code);

describe('evaluateSponsorCorrection', () => {
  it('accepts a valid move', () => {
    expect(codes({})).toEqual([]);
    expect(codes({ currentSponsorId: null })).toEqual([]);
  });

  it('rejects self-sponsoring and cycles', () => {
    expect(codes({ newSponsor: { ...base.newSponsor, id: 'm' }, newSponsorInMemberSubtree: true })).toEqual([
      'SELF_SPONSOR',
    ]);
    expect(codes({ newSponsorInMemberSubtree: true })).toEqual(['CYCLE']);
  });

  it('rejects a no-op and an inactive or unverified sponsor', () => {
    expect(codes({ currentSponsorId: 'new' })).toEqual(['SAME_SPONSOR']);
    expect(codes({ newSponsor: { id: 'new', status: 'SUSPENDED', emailVerified: true } })).toEqual(['SPONSOR_INACTIVE']);
    expect(codes({ newSponsor: { id: 'new', status: 'ACTIVE', emailVerified: false } })).toEqual(['SPONSOR_INACTIVE']);
  });

  it('enforces segregation of duties', () => {
    expect(codes({ performerId: 'm' })).toEqual(['SEGREGATION_OF_DUTIES']);
    expect(codes({ performerId: 'old' })).toEqual(['SEGREGATION_OF_DUTIES']);
    expect(codes({ performerId: 'new' })).toEqual(['SEGREGATION_OF_DUTIES']);
    expect(codes({ performerIsUplineOfNewSponsor: true })).toEqual(['SEGREGATION_OF_DUTIES']);
  });

  it('blocks while the moved team has unprocessed sales', () => {
    expect(codes({ receivedEventCount: 2 })).toEqual(['RECEIVED_EVENTS']);
  });
});
