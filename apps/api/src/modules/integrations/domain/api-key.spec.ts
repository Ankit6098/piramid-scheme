import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, looksLikeApiKey, parseBearer } from './api-key';

describe('api keys', () => {
  it('generates prefixed random keys with a display prefix and a SHA-256 hash', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.apiKey).toMatch(/^rpk_[A-Za-z0-9_-]{43}$/);
    expect(a.apiKey).not.toBe(b.apiKey);
    expect(a.keyPrefix).toBe(a.apiKey.slice(0, 12));
    expect(a.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(a.apiKey)).toBe(a.keyHash);
    expect(looksLikeApiKey(a.apiKey)).toBe(true);
    expect(looksLikeApiKey('rpk_short')).toBe(false);
  });

  it('parses bearer tokens', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
    expect(parseBearer('bearer   abc  ')).toBe('abc');
    expect(parseBearer(['Bearer xyz'])).toBe('xyz');
    expect(parseBearer('Basic abc')).toBeNull();
    expect(parseBearer('Bearer a b')).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });
});
