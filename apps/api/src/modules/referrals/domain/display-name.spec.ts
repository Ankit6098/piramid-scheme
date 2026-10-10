import { describe, expect, it } from 'vitest';
import { escapeLike, nameSearchPatterns, statusBucketOf, toDisplayName } from './display-name';

describe('toDisplayName', () => {
  it('shows first name + last initial', () => {
    expect(toDisplayName('Anita Sharma')).toBe('Anita S.');
    expect(toDisplayName('  Anita   Kumari  sharma ')).toBe('Anita S.');
  });
  it('keeps single-word names and handles empty input', () => {
    expect(toDisplayName('Madonna')).toBe('Madonna');
    expect(toDisplayName('   ')).toBe('Member');
  });
  it('uses the first code point of the last name', () => {
    expect(toDisplayName('Zoë Ørsted')).toBe('Zoë Ø.');
  });
});

describe('statusBucketOf', () => {
  it('maps only ACTIVE to the active bucket', () => {
    expect(statusBucketOf('ACTIVE')).toBe('ACTIVE');
    expect(statusBucketOf('SUSPENDED')).toBe('INACTIVE');
    expect(statusBucketOf('DEACTIVATED')).toBe('INACTIVE');
    expect(statusBucketOf('PENDING_VERIFICATION')).toBe('INACTIVE');
  });
});

describe('name search patterns', () => {
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
  it('uses the longest token of ≥ 3 chars as the trigram prefilter', () => {
    expect(nameSearchPatterns('  anita   s. ')).toEqual({ pattern: '%anita s.%', prefilter: '%anita%' });
    expect(nameSearchPatterns('ra')).toEqual({ pattern: '%ra%', prefilter: null });
    expect(nameSearchPatterns('a_b%c')).toEqual({ pattern: '%a\\_b\\%c%', prefilter: '%a\\_b\\%c%' });
  });
});
