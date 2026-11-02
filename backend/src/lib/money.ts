/** The largest value an integer column holds. */
export const INT4_MAX = 2_147_483_647;

/** Platform commission on one order, in paise, rounded to the nearest paisa. */
export function commissionPaise(pricePaise: number, bps: number): number {
  return Math.round((pricePaise * bps) / 10000);
}

/** What the vendor receives for one order, in paise. */
export function vendorNetPaise(o: {
  pricePaise: number;
  commissionPaise: number;
  feePaise: number;
  taxPaise: number;
}): number {
  return o.pricePaise - o.commissionPaise - o.feePaise - o.taxPaise;
}
