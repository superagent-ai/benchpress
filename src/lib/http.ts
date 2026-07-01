import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

export type EnsureFileDownloadedOptions = {
  /** Expected sha256 of the downloaded file. Verified after download; mismatches throw. */
  expectedSha256?: string;
};

/**
 * Downloads `url` to `destPath` unless it already exists (content-addressed
 * vendor caches are immutable, so presence alone is a valid cache hit).
 * Downloads to a `.part` sibling first so a killed process never leaves a
 * corrupt file at `destPath`.
 */
export async function ensureFileDownloaded(
  url: string,
  destPath: string,
  options: EnsureFileDownloadedOptions = {},
): Promise<string> {
  if (await pathExists(destPath)) {
    if (options.expectedSha256) await assertSha256(destPath, options.expectedSha256, url);
    return destPath;
  }

  await mkdir(path.dirname(destPath), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }

  const tmpPath = `${destPath}.part`;
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmpPath));

  if (options.expectedSha256) {
    await assertSha256(tmpPath, options.expectedSha256, url).catch(async (error) => {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    });
  }

  await rename(tmpPath, destPath);
  return destPath;
}

async function assertSha256(filePath: string, expected: string, sourceUrl: string): Promise<void> {
  const actual = await sha256File(filePath);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${sourceUrl}: expected sha256 ${expected}, got ${actual}`);
  }
}
