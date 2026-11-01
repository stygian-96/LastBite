export type Bucket = 'public' | 'private';

/** How long a signed upload or read link stays valid. */
export const SIGNED_URL_SECONDS = 300;

export interface ObjectStore {
  /** A link the browser can PUT one file to. Refuses other content types and files over maxBytes. */
  signedUpload(key: string, contentType: string, bucket: Bucket, maxBytes: number): Promise<string>;
  /** A short-lived link to read a private file. */
  signedRead(key: string): Promise<string>;
  /** The permanent link to a file in the public bucket. */
  publicUrl(key: string): string;
}

export type RecordedUpload = { key: string; contentType: string; bucket: Bucket; maxBytes: number };

/** Records upload requests and returns made-up links. Used by tests and until the real adapter is wired. */
export class FakeStore implements ObjectStore {
  readonly uploads: RecordedUpload[] = [];

  async signedUpload(key: string, contentType: string, bucket: Bucket, maxBytes: number): Promise<string> {
    this.uploads.push({ key, contentType, bucket, maxBytes });
    return `https://fake-storage.test/${bucket}/${key}?expires=${SIGNED_URL_SECONDS}&max=${maxBytes}`;
  }

  async signedRead(key: string): Promise<string> {
    return `https://fake-storage.test/private/${key}?expires=${SIGNED_URL_SECONDS}`;
  }

  publicUrl(key: string): string {
    return `https://fake-storage.test/public/${key}`;
  }
}

let store: ObjectStore = new FakeStore();

export function getStore(): ObjectStore {
  return store;
}

export function setStore(s: ObjectStore): void {
  store = s;
}
