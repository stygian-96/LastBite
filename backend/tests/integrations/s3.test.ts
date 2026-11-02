import { describe, expect, test } from 'vitest';
import { S3Store } from '../../src/integrations/s3.js';

const store = new S3Store({
  region: 'ap-south-1',
  publicBucket: 'lb-public',
  privateBucket: 'lb-private',
  credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test' },
});

describe('S3Store', () => {
  test('an upload link lasts 5 minutes, and signs the type and exact size', async () => {
    const url = new URL(await store.signedUpload('docs/u/a.pdf', 'application/pdf', 'private', 2048));
    expect(url.hostname).toContain('lb-private');
    expect(url.pathname).toBe('/docs/u/a.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(expect.arrayContaining(['content-length', 'content-type']));
    // A checksum in the link would make every browser PUT fail.
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
  });

  test('uploads go to the bucket asked for', async () => {
    const url = new URL(await store.signedUpload('photos/u/a.jpg', 'image/jpeg', 'public', 10));
    expect(url.hostname).toContain('lb-public');
  });

  test('a read link is for the private bucket and lasts 5 minutes', async () => {
    const url = new URL(await store.signedRead('docs/u/a.pdf'));
    expect(url.hostname).toContain('lb-private');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  test('a public link is the plain address, or under the base URL given', () => {
    expect(store.publicUrl('photos/a b.jpg')).toBe('https://lb-public.s3.ap-south-1.amazonaws.com/photos/a%20b.jpg');
    const cdn = new S3Store({ region: 'ap-south-1', publicBucket: 'p', privateBucket: 'q', publicBaseUrl: 'https://cdn.example.com/' });
    expect(cdn.publicUrl('photos/a.jpg')).toBe('https://cdn.example.com/photos/a.jpg');
  });
});
