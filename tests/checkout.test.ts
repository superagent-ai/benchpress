import { describe, expect, it } from 'vitest';
import { ensureVendorClone } from '../src/lib/checkout.js';

describe('checkout clone failures', () => {
  // Regression: a failed clone used to resolve silently, surfacing later as a
  // confusing `spawn git ENOENT` from a subsequent command run against the
  // still-missing checkout directory instead of the real clone error (auth,
  // bad ref, network, etc. -- discovered while verifying the cve-bench
  // adapter's autobrin contender path). A nonexistent *local* path fails git
  // clone fast and deterministically without needing real network access in
  // CI; `ensureAutobrinCheckout` shares the same `cloneOrThrow`/
  // `isExistingCheckout` helpers exercised here.
  it('ensureVendorClone throws a descriptive error instead of a misleading spawn ENOENT', async () => {
    await expect(
      ensureVendorClone({ repo: '/nonexistent/local/repo-path', commit: 'deadbeef', dirName: `missing-${Date.now()}` }),
    ).rejects.toThrow(/git clone failed/);
  });
});
