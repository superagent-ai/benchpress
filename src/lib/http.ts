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
  /** Expected sha256 of the downloaded file. A freshly-downloaded mismatch throws (real corruption/tampering). */
  expectedSha256?: string;
};

/**
 * Downloads `url` to `destPath` unless a cached copy already matches
 * `expectedSha256` (content-addressed vendor caches are immutable, so a
 * hash match -- not mere presence -- is what makes a cache hit valid).
 * Downloads to a `.part` sibling first so a killed process never leaves a
 * corrupt file at `destPath`.
 */
export async function ensureFileDownloaded(
  url: string,
  destPath: string,
  options: EnsureFileDownloadedOptions = {},
): Promise<string> {
  if (await pathExists(destPath)) {
    if (!options.expectedSha256 || (await sha256File(destPath)) === options.expectedSha256) {
      return destPath;
    }
    // Stale cache, not corruption: a pinned checksum (e.g. tasks.jsonc's
    // repoVulSha256) changed since this file was downloaded. Treat it as a
    // cache miss and re-download instead of failing forever until someone
    // manually deletes it.
    await unlink(destPath).catch(() => undefined);
  }

  await mkdir(path.dirname(destPath), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }

  const tmpPath = `${destPath}.part`;
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmpPath));

  if (options.expectedSha256) {
    const actual = await sha256File(tmpPath);
    if (actual !== options.expectedSha256) {
      await unlink(tmpPath).catch(() => undefined);
      throw new Error(`Checksum mismatch for ${url}: expected sha256 ${options.expectedSha256}, got ${actual}`);
    }
  }

  await rename(tmpPath, destPath);
  return destPath;
}
