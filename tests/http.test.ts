import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureFileDownloaded } from '../src/lib/http.js';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('ensureFileDownloaded (hermetic -- fetch is stubbed, no real network)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function tmpFilePath(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'benchpress-http-test-'));
    tmpDirs.push(dir);
    return path.join(dir, 'file.bin');
  }

  it('downloads and verifies a fresh file when nothing is cached', async () => {
    const destPath = await tmpFilePath();
    const content = 'hello-world';
    const fetchMock = vi.fn().mockResolvedValue(new Response(content, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureFileDownloaded('https://example.test/file.bin', destPath, {
      expectedSha256: sha256(content),
    });

    expect(result).toBe(destPath);
    expect(await readFile(destPath, 'utf8')).toBe(content);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips downloading when a cached file already matches expectedSha256', async () => {
    const destPath = await tmpFilePath();
    const content = 'already-cached';
    await writeFile(destPath, content, 'utf8');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureFileDownloaded('https://example.test/file.bin', destPath, {
      expectedSha256: sha256(content),
    });

    expect(result).toBe(destPath);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-downloads when a cached file no longer matches expectedSha256 instead of failing forever (regression: Bugbot checksum-pin-change)', async () => {
    const destPath = await tmpFilePath();
    await writeFile(destPath, 'stale-content-from-old-pin', 'utf8');
    const freshContent = 'fresh-content-from-new-pin';
    const fetchMock = vi.fn().mockResolvedValue(new Response(freshContent, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureFileDownloaded('https://example.test/file.bin', destPath, {
      expectedSha256: sha256(freshContent),
    });

    expect(result).toBe(destPath);
    expect(await readFile(destPath, 'utf8')).toBe(freshContent);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws and cleans up the temp file when a freshly-downloaded file fails checksum verification (real corruption/tampering)', async () => {
    const destPath = await tmpFilePath();
    const fetchMock = vi.fn().mockResolvedValue(new Response('unexpected-content', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ensureFileDownloaded('https://example.test/file.bin', destPath, { expectedSha256: sha256('expected-content') }),
    ).rejects.toThrow(/Checksum mismatch/);

    await expect(readFile(destPath)).rejects.toThrow();
    await expect(readFile(`${destPath}.part`)).rejects.toThrow();
  });

  it('throws a clear error on HTTP failure', async () => {
    const destPath = await tmpFilePath();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureFileDownloaded('https://example.test/missing.bin', destPath)).rejects.toThrow(/HTTP 404/);
  });
});
