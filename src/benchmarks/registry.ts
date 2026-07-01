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

/** Benchmarks still stubbed pending an autobrin-flue capability. `cve-bench` and `owasp` were
 * unblocked once their dependency shipped (`webapp` modality + computer-use confirmation, and
 * detect-only mode respectively -- see `src/benchmarks/cve-bench/adapter.ts` and
 * `src/benchmarks/owasp/adapter.ts`); neither appears here anymore. */
export const BENCHMARK_CAPABILITY_DEPENDENCIES: Record<string, string> = {
  cybergym: 'PoC-generation contributor skill + differential patched oracle',
  bountybench:
    'score() requires detect-only mode (autobrin-flue#182, unmerged) for detect/patch; exploit lane is fully implemented',
  'repo-cve-smoke': 'repo modality only (dev-smoke lane; not for scientific reporting)',
};
