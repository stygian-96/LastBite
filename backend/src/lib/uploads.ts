import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rateLimit } from './rate-limit.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOADS_PER_HOUR = 30;
const HOUR_SECONDS = 3600;

// Only these types are accepted. SVG is left out on purpose: photos go to a public bucket and SVG can carry script.
const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
} as const;
const CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'] as const;

/** The file an upload link is asked for. */
export const uploadFile = z.object({
  contentType: z.enum(CONTENT_TYPES),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});

/** Upload links cost storage and signing, so each user gets so many an hour, across every upload route. */
export const limitUploads = (userId: string, now: Date) => rateLimit(`uploads:${userId}`, UPLOADS_PER_HOUR, HOUR_SECONDS, now);

/** A new key under the caller's prefix in this folder. */
export function uploadKey(folder: string, userId: string, contentType: keyof typeof EXTENSIONS): string {
  return `${folder}/${userId}/${randomUUID()}.${EXTENSIONS[contentType]}`;
}
