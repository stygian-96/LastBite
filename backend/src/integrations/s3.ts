import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../lib/env.js';
import { SIGNED_URL_SECONDS, type Bucket, type ObjectStore } from './storage.js';

export type S3Config = {
  region: string;
  publicBucket: string;
  privateBucket: string;
  publicBaseUrl?: string;
  /** Left out in production, where the SDK finds them itself. */
  credentials?: { accessKeyId: string; secretAccessKey: string };
};

/** Two buckets: photos are public, documents and issue photos are private and read by signed link. */
export class S3Store implements ObjectStore {
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    this.client = new S3Client({
      region: config.region,
      credentials: config.credentials,
      // By default the SDK puts a checksum in the link, of an empty body, which fails a browser PUT.
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  signedUpload(key: string, contentType: string, bucket: Bucket, sizeBytes: number): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: bucket === 'public' ? this.config.publicBucket : this.config.privateBucket,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
    });
    // Both are signed, so S3 refuses a file of another type or size than the one asked for.
    return getSignedUrl(this.client, command, {
      expiresIn: SIGNED_URL_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  signedRead(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.privateBucket, Key: key }), {
      expiresIn: SIGNED_URL_SECONDS,
    });
  }

  publicUrl(key: string): string {
    const { publicBaseUrl, publicBucket, region } = this.config;
    const base = publicBaseUrl?.replace(/\/$/, '') ?? `https://${publicBucket}.s3.${region}.amazonaws.com`;
    return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
}

export function s3FromEnv(): S3Store {
  const e = env();
  if (!e.AWS_REGION || !e.S3_PUBLIC_BUCKET || !e.S3_PRIVATE_BUCKET) throw new Error('S3 is not configured');
  return new S3Store({
    region: e.AWS_REGION,
    publicBucket: e.S3_PUBLIC_BUCKET,
    privateBucket: e.S3_PRIVATE_BUCKET,
    publicBaseUrl: e.S3_PUBLIC_BASE_URL,
  });
}
