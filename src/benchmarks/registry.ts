import type { BenchmarkAdapter } from './types.js';
import { cveBenchAdapter } from './cve-bench/adapter.js';
import { cyberGymAdapter } from './cybergym/adapter.js';
import { bountyBenchAdapter } from './bountybench/adapter.js';
import { owaspAdapter } from './owasp/adapter.js';
import { repoCveSmokeAdapter } from './repo-cve-smoke/adapter.js';

const BENCHMARKS: BenchmarkAdapter[] = [
  repoCveSmokeAdapter,
  cveBenchAdapter,
  cyberGymAdapter,
  bountyBenchAdapter,
  owaspAdapter,
];

const byId = new Map(BENCHMARKS.map((adapter) => [adapter.id, adapter]));

export function listBenchmarks(): BenchmarkAdapter[] {
  return [...BENCHMARKS];
}

export function resolveBenchmark(id: string): BenchmarkAdapter {
  const adapter = byId.get(id);
  if (!adapter) {
    throw new Error(`Unknown benchmark: ${id}. Known: ${[...byId.keys()].join(', ')}`);
  }
  return adapter;
}

export function listRunnableBenchmarks(): BenchmarkAdapter[] {
  return BENCHMARKS.filter((adapter) => adapter.lane === 'dev-smoke');
}

/** Benchmarks still stubbed pending an autobrin-flue capability. `cve-bench` was
 * unblocked once `webapp` modality + computer-use confirmation shipped (see
 * `src/benchmarks/cve-bench/adapter.ts`); it no longer appears here. */
export const BENCHMARK_CAPABILITY_DEPENDENCIES: Record<string, string> = {
  cybergym: 'PoC-generation contributor skill + differential patched oracle',
  bountybench: 'webapp + computer-use (exploit) / detect-only mode (detect)',
  owasp: 'detect-only mode + CWE-label Youden scoring',
  'repo-cve-smoke': 'repo modality only (dev-smoke lane; not for scientific reporting)',
};
