/**
 * Storage module – placeholder
 * In the standalone Railway version, we store label images as base64 data URLs
 * directly in the database instead of using S3.
 * This file is kept for potential future S3 integration.
 */

// No-op exports for compatibility
export async function storagePut(
  _relKey: string,
  _data: Buffer | Uint8Array | string,
  _contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  throw new Error("S3 storage not configured in standalone mode. Use base64 data URLs instead.");
}

export async function storageGet(_relKey: string): Promise<{ key: string; url: string }> {
  throw new Error("S3 storage not configured in standalone mode.");
}
