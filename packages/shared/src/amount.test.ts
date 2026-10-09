import { describe, expect, it } from 'vitest';
import { decimalToMinor, formatAmount, formatBps, minorToDecimalString } from './amount';

describe('amount helpers', () => {
  it('converts minor units to exact decimal strings', () => {
    expect(minorToDecimalString(150000n, 2)).toBe('1500.00');
    expect(minorToDecimalString('5', 2)).toBe('0.05');
    expect(minorToDecimalString(-5n, 2)).toBe('-0.05');
    expect(minorToDecimalString(42n, 0)).toBe('42');
    expect(minorToDecimalString('900719925474099312', 2)).toBe('9007199254740993.12');
  });

  it('parses decimals into minor units without floating point', () => {
    expect(decimalToMinor('1,500.5', 2)).toBe(150050n);
    expect(decimalToMinor('0.1', 2)).toBe(10n);
    expect(decimalToMinor('10', 0)).toBe(10n);
    expect(decimalToMinor('1.234', 2)).toBeNull();
    expect(decimalToMinor('abc', 2)).toBeNull();
    expect(decimalToMinor('-1', 2)).toBeNull();
  });

  it('formats money and points', () => {
    const money = formatAmount('150000', {
      unit: 'MONEY',
      currencyCode: 'INR',
      minorUnits: 2,
      pointsLabel: 'Points',
    });
    expect(money).toContain('1,500.00');
    expect(money).toContain('₹');
    expect(
      formatAmount(1500n, { unit: 'POINTS', currencyCode: 'INR', minorUnits: 2, pointsLabel: 'Points' }),
    ).toBe('1,500 Points');
  });

  it('formats basis points', () => {
    expect(formatBps(1000)).toBe('10%');
    expect(formatBps(250)).toBe('2.5%');
    expect(formatBps(125)).toBe('1.25%');
  });
});
