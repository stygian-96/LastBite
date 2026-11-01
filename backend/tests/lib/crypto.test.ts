import { describe, expect, test } from 'vitest';
import { decrypt, encrypt, hashToken, signAnonId, verifyAnonId } from '../../src/lib/crypto.js';

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
