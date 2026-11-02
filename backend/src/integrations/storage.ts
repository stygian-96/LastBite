import { devFakeProviders } from '../lib/env.js';
import { s3FromEnv } from './s3.js';

export type Bucket = 'public' | 'private';

/** How long a signed upload or read link stays valid. */
export const SIGNED_URL_SECONDS = 300;

export interface ObjectStore {
  /** A link the browser can PUT one file to. Refuses other content types and any other size. */
  signedUpload(key: string, contentType: string, bucket: Bucket, sizeBytes: number): Promise<string>;
  /** A short-lived link to read a private file. */
  signedRead(key: string): Promise<string>;
  /** The permanent link to a file in the public bucket. */
  publicUrl(key: string): string;
}

export type RecordedUpload = { key: string; contentType: string; bucket: Bucket; sizeBytes: number };

/** Records upload requests and returns made-up links. Used by tests, and by local development that asks for it. */
export class FakeStore implements ObjectStore {
  readonly uploads: RecordedUpload[] = [];

  async signedUpload(key: string, contentType: string, bucket: Bucket, sizeBytes: number): Promise<string> {
    this.uploads.push({ key, contentType, bucket, sizeBytes });
    return `https://fake-storage.test/${bucket}/${key}?expires=${SIGNED_URL_SECONDS}&size=${sizeBytes}`;
  }

  async signedRead(key: string): Promise<string> {
    return `https://fake-storage.test/private/${key}?expires=${SIGNED_URL_SECONDS}`;
  }

  publicUrl(key: string): string {
    return `https://fake-storage.test/public/${key}`;
  }
}

let store: ObjectStore | undefined;

/** The real one in production. Only tests and DEV_FAKE_PROVIDERS get the fake. */
export function getStore(): ObjectStore {
  if (store) return store;
  if (process.env.NODE_ENV === 'production') store = s3FromEnv();
  else if (process.env.NODE_ENV === 'test' || devFakeProviders()) store = new FakeStore();
  else throw new Error('No file store outside production and tests');
  return store;
}

export function setStore(s: ObjectStore): void {
  store = s;
}
