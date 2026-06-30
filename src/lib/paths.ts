import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function repoRoot(): string {
  return path.resolve(moduleDir, '../..');
}

export function cacheRoot(): string {
  return path.join(repoRoot(), '.cache');
}

export function runsRoot(): string {
  return path.join(repoRoot(), 'runs');
}

export function resultsRoot(): string {
  return path.join(repoRoot(), 'results');
}

export function vendorRoot(): string {
  return path.join(repoRoot(), 'vendor');
}

export function engagementsRoot(): string {
  return path.join(repoRoot(), 'engagements');
}
