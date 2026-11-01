import { describe, expect, test } from 'vitest';
import { pickupBounds, serviceDate } from '../../src/lib/time.js';

describe('time', () => {
  test('serviceDate is the IST calendar date', () => {
    expect(serviceDate(new Date('2026-11-01T18:29:00Z'))).toBe('2026-11-01');
    expect(serviceDate(new Date('2026-11-01T18:30:00Z'))).toBe('2026-11-02');
  });

  test('pickupBounds crosses midnight and ends sales 15 minutes early', () => {
    const b = pickupBounds('2026-11-01', '23:30', '00:30');
    expect(b.startAt.toISOString()).toBe('2026-11-01T18:00:00.000Z');
    expect(b.endAt.getTime() - b.startAt.getTime()).toBe(3_600_000);
    expect(b.salesEndAt.toISOString()).toBe('2026-11-01T18:45:00.000Z');
  });

  test('pickupBounds within one day', () => {
    const b = pickupBounds('2026-11-01', '20:00', '21:00');
    expect(b.startAt.toISOString()).toBe('2026-11-01T14:30:00.000Z');
    expect(b.endAt.toISOString()).toBe('2026-11-01T15:30:00.000Z');
  });
});
