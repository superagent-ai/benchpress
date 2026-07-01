import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './git.js';

const MARKER_FILE = '.extracted-from';

async function readMarker(destDir: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(destDir, MARKER_FILE), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Extracts a `.tar.gz` into `destDir`, skipping extraction only if `destDir`
 * was already populated from the same `marker` (e.g. the tarball's verified
 * sha256). Keying the cache hit on content identity -- not just "destDir is
 * non-empty" -- matters because `ensureFileDownloaded` re-downloads whenever
 * a pinned checksum changes; without this, a stale extracted tree could
 * silently survive a tarball refresh. Shells out to the system `tar`
 * (present on macOS/Linux CI runners) rather than adding an npm archive
 * dependency.
 */
export async function extractTarGz(tarballPath: string, destDir: string, marker: string): Promise<string> {
  if ((await readMarker(destDir)) === marker) return destDir;

  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  const { exitCode, stderr, stdout } = await runCommand('tar', ['-xzf', tarballPath, '-C', destDir]);
  if (exitCode !== 0) {
    throw new Error(`tar -xzf ${tarballPath} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  await writeFile(path.join(destDir, MARKER_FILE), marker, 'utf8');
  return destDir;
}
