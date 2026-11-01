// 24 letters (no I or O, which read as 1 and 0 at a counter) followed by three digits.
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** A pickup code such as `K482`. `rand` returns a number in [0, 1) and is injectable for tests. */
export function generatePickupCode(rand: () => number = Math.random): string {
  const letter = LETTERS[Math.floor(rand() * LETTERS.length)]!;
  const digits = String(Math.floor(rand() * 1000)).padStart(3, '0');
  return `${letter}${digits}`;
}
