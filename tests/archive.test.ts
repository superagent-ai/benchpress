import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { runCommand } from '../src/lib/git.js';
import { extractTarGz } from '../src/lib/archive.js';

describe('extractTarGz (hermetic -- local tarballs only, no network)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function makeTarball(contents: string): Promise<{ dir: string; tarballPath: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'benchpress-archive-test-'));
    tmpDirs.push(dir);
    const srcDir = path.join(dir, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'payload.txt'), contents, 'utf8');
    const tarballPath = path.join(dir, 'archive.tar.gz');
    const { exitCode, stderr } = await runCommand('tar', ['-czf', tarballPath, '-C', srcDir, '.']);
    if (exitCode !== 0) throw new Error(`failed to build fixture tarball: ${stderr}`);
    return { dir, tarballPath };
  }

  it('extracts a real tarball and writes its contents to destDir', async () => {
    const { dir, tarballPath } = await makeTarball('hello-v1');
    const destDir = path.join(dir, 'out');

    await extractTarGz(tarballPath, destDir, 'marker-v1');

    expect(await readFile(path.join(destDir, 'payload.txt'), 'utf8')).toBe('hello-v1');
  });

  it('skips re-extraction when destDir already matches the same marker (cache hit)', async () => {
    const { dir, tarballPath } = await makeTarball('hello-v1');
    const destDir = path.join(dir, 'out');

    await extractTarGz(tarballPath, destDir, 'marker-v1');
    // Simulate a cache hit by mutating the extracted file directly -- if the
    // second call is truly a no-op, this mutation must survive.
    await writeFile(path.join(destDir, 'payload.txt'), 'mutated-after-first-extract', 'utf8');

    await extractTarGz(tarballPath, destDir, 'marker-v1');

    expect(await readFile(path.join(destDir, 'payload.txt'), 'utf8')).toBe('mutated-after-first-extract');
  });

  it('re-extracts when the marker changes, discarding the stale tree (regression: Bugbot stale-extract-on-refresh)', async () => {
    const { dir, tarballPath } = await makeTarball('hello-v1');
    const destDir = path.join(dir, 'out');
    await extractTarGz(tarballPath, destDir, 'marker-v1');

    // A pinned checksum changed and the tarball was refreshed in place --
    // extractTarGz must not silently keep serving the v1 extracted tree.
    const { dir: dir2, tarballPath: tarballPathV2 } = await makeTarball('hello-v2');
    tmpDirs.push(dir2);
    await extractTarGz(tarballPathV2, destDir, 'marker-v2');

    expect(await readFile(path.join(destDir, 'payload.txt'), 'utf8')).toBe('hello-v2');
    const entries = await readdir(destDir);
    expect(entries.filter((entry) => entry !== '.extracted-from')).toEqual(['payload.txt']);
  });
});
