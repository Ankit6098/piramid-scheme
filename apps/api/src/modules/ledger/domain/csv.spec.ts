import { describe, expect, it } from 'vitest';
import { csvCell, csvFilename, csvRow } from './csv';

describe('csvCell', () => {
  it('renders primitives and empty values', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(123n)).toBe('123');
    expect(csvCell(4)).toBe('4');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(new Date('2026-10-10T05:06:07.000Z'))).toBe('2026-10-10T05:06:07.000Z');
    expect(csvCell('plain text')).toBe('plain text');
  });

  it.each([
    ['=HYPERLINK("http://evil")', `"'=HYPERLINK(""http://evil"")"`],
    ['+1+2', "'+1+2"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', `"'\rcmd"`],
  ])('neutralizes formula trigger %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('quotes separators, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('does not touch triggers that are not at the start', () => {
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('x-y')).toBe('x-y');
  });
});

describe('csvRow / csvFilename', () => {
  it('joins cells with commas and ends with CRLF', () => {
    expect(csvRow(['a', 1n, null, '=x'])).toBe("a,1,,'=x\r\n");
  });

  it('builds a dated filename', () => {
    expect(csvFilename('rewards', new Date('2026-10-10T23:59:00Z'))).toBe('rewards-2026-10-10.csv');
  });
});
