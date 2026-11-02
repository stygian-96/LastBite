import { describe, expect, test } from 'vitest';
import { decrypt, encrypt, hashToken, signAnonId, verifyAnonId, verifyHexHmac } from '../../src/lib/crypto.js';

describe('verifyHexHmac', () => {
  const raw = '{"event":"payment.captured"}';
  // HMAC-SHA256 of raw under 'webhook-secret', worked out outside this code.
  const signature = '0e95258623492dd0dae77245c958c256d46b4a30b338084b7e996fc25653c79c';

  test('matches a known HMAC of the raw body', () => {
    expect(verifyHexHmac('webhook-secret', raw, signature)).toBe(true);
  });

  test('refuses another secret, another body, a wrong length and an empty signature', () => {
    expect(verifyHexHmac('other', raw, signature)).toBe(false);
    expect(verifyHexHmac('webhook-secret', `${raw} `, signature)).toBe(false);
    expect(verifyHexHmac('webhook-secret', raw, 'abc')).toBe(false);
    expect(verifyHexHmac('webhook-secret', raw, '')).toBe(false);
  });
});

describe('crypto', () => {
  test('decrypt reverses encrypt, and ciphertext differs each time', () => {
    const a = encrypt('rzp_secret_123');
    const b = encrypt('rzp_secret_123');
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a)).toBe('rzp_secret_123');
    expect(decrypt(b)).toBe('rzp_secret_123');
  });

  test('tampered ciphertext throws', () => {
    const a = encrypt('hello');
    a[a.length - 1] ^= 1;
    expect(() => decrypt(a)).toThrow();
  });

  test('hashToken is stable SHA-256 hex', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('anon ID round-trips', () => {
    const id = '5b0f0a6e-6a4e-4f55-9a49-0d9a8b7d1c11';
    expect(verifyAnonId(signAnonId(id))).toBe(id);
  });

  test('tampered anon ID verifies to null', () => {
    const signed = signAnonId('abc');
    expect(verifyAnonId(signed.replace('abc', 'abd'))).toBeNull();
    expect(verifyAnonId(`${signed}x`)).toBeNull();
    expect(verifyAnonId('nodot')).toBeNull();
  });
});
