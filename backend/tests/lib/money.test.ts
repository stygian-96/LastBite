import { describe, expect, test } from 'vitest';
import { commissionPaise, vendorNetPaise } from '../../src/lib/money.js';

describe('money', () => {
  test('commission rounds to the nearest paisa', () => {
    expect(commissionPaise(14900, 2000)).toBe(2980);
    expect(commissionPaise(14999, 2000)).toBe(3000);
  });

  test('vendor net is price minus commission, fee and tax', () => {
    expect(vendorNetPaise({ pricePaise: 14900, commissionPaise: 2980, feePaise: 300, taxPaise: 0 })).toBe(11620);
  });
});
