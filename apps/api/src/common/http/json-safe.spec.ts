import { describe, expect, it } from 'vitest';
import { bigintJsonReplacer, toJsonSafe, toJsonValue } from './json-safe';

describe('toJsonSafe', () => {
  it('converts bigint to decimal strings deeply, keeps Dates, drops undefined members', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const out = toJsonSafe({ a: 1n, b: [2n, { c: 9_007_199_254_740_993n }], at, u: undefined, n: null, s: new Set([3n]), m: new Map([['k', 4n]]) });
    expect(out).toEqual({ a: '1', b: ['2', { c: '9007199254740993' }], at, n: null, s: ['3'], m: { k: '4' } });
    expect(JSON.stringify(out)).toBe(
      '{"a":"1","b":["2",{"c":"9007199254740993"}],"at":"2026-01-01T00:00:00.000Z","n":null,"s":["3"],"m":{"k":"4"}}',
    );
  });

  it('leaves class instances (Buffer etc.) untouched and rejects cycles', () => {
    const buf = Buffer.from('x');
    expect(toJsonSafe({ buf })).toEqual({ buf });
    expect((toJsonSafe({ buf }) as { buf: Buffer }).buf).toBe(buf);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => toJsonSafe(cyc)).toThrow(/circular/);
  });

  it('the replacer handles bigint for JSON.stringify', () => {
    expect(JSON.stringify({ v: 10n }, bigintJsonReplacer)).toBe('{"v":"10"}');
  });

  it('toJsonValue produces plain JSON data (Date → ISO string)', () => {
    expect(toJsonValue({ at: new Date('2026-01-01T00:00:00.000Z'), v: 1n })).toEqual({ at: '2026-01-01T00:00:00.000Z', v: '1' });
  });
});
