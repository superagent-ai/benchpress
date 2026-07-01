import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureVendorClone } from '../../lib/checkout.js';
import { readJsonRequired } from '../../lib/json.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export type OwaspVendorLock = {
  repo: string;
  commit: string;
};

/** `vendor.lock.json` pins OWASP Benchmark for Java v1.2 (2,740 CWE-labeled servlet test cases). */
export async function readOwaspVendorLock(): Promise<OwaspVendorLock> {
  return readJsonRequired<OwaspVendorLock>(path.join(moduleDir, 'vendor.lock.json'));
}

/** Clones the pinned OWASP BenchmarkJava commit into `.cache/vendor/owasp`. Idempotent. */
export async function setupOwaspVendor(): Promise<string> {
  const lock = await readOwaspVendorLock();
  return ensureVendorClone({ repo: lock.repo, commit: lock.commit, dirName: 'owasp' });
}
