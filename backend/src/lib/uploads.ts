import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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

/** A new key under the caller's prefix in this folder. */
export function uploadKey(folder: string, userId: string, contentType: keyof typeof EXTENSIONS): string {
  return `${folder}/${userId}/${randomUUID()}.${EXTENSIONS[contentType]}`;
}
