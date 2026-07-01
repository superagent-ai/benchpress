import type { BenchmarkAdapter } from '../types.js';
import { NotImplementedBenchmarkError } from '../types.js';
import type { BenchmarkTask, TargetHandle } from '../../contenders/types.js';
import { setupOwaspVendor, readOwaspVendorLock } from './setup.js';
import { readExpectedResults, sampleRepresentative, type OwaspTestCase } from './tasks.js';

const SCORE_BLOCKED_ON =
  'Requires autobrin-flue detect-only mode (superagent-ai/autobrin-flue#182, unmerged): score() needs a ' +
  "confirmed/rejected verdict per test case without running the full exploitation chain, then to map that " +
  'verdict against expectedresults-1.2.csv ground truth into OracleScore (TP/FP/FN/TN) and youdenIndex(). ' +
  'setup(), listTasks(), and standUpTarget() are real and working; only score() is blocked.';

export const owaspAdapter: BenchmarkAdapter = {
  id: 'owasp',
  lane: 'scientific',
  description: 'OWASP Benchmark for Java v1.2: CWE-labeled servlet test cases with Youden scoring.',

  async setup() {
    await setupOwaspVendor();
  },

  async listTasks(): Promise<BenchmarkTask[]> {
    const vendorRoot = await setupOwaspVendor();
    const allCases = await readExpectedResults(vendorRoot);
    const sample = sampleRepresentative(allCases);
    return sample.map((testCase) => ({
      id: testCase.testName,
      benchmarkId: 'owasp',
      metadata: testCase,
    }));
  },

  // modality: 'repo', not 'webapp' - investigated rather than assumed (see
  // owasp/README.md "Modality"). OWASP Benchmark test cases are single Java
  // servlets that are equally valid targets for static analysis (the
  // Benchmark's own docs and CI run CodeQL/SpotBugs/PMD directly against the
  // source, no live app needed) as for HTTP-based DAST scanning, and
  // AutoBrin's repo-modality contender path (contenders/autobrin.ts) only
  // ever clones+checks out source - it has no concept of a live target URL.
  // So there is nothing to boot for the TargetHandle itself; the pinned
  // commit's buildability was verified separately (see README "Verification").
  async standUpTarget(task: BenchmarkTask): Promise<TargetHandle> {
    const lock = await readOwaspVendorLock();
    const testCase = task.metadata as OwaspTestCase;
    return {
      benchmarkId: 'owasp',
      taskId: task.id,
      modality: 'repo',
      repo: lock.repo,
      sha: lock.commit,
      metadata: {
        ...testCase,
        changedPaths: [testCase.javaSourcePath],
      },
    };
  },

  score() {
    throw new NotImplementedBenchmarkError('owasp', SCORE_BLOCKED_ON);
  },
};
