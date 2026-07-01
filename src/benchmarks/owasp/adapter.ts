import type { BenchmarkAdapter } from '../types.js';
import type { BenchmarkTask, ConfirmedFinding, ContenderClaim, TargetHandle } from '../../contenders/types.js';
import type { OracleScore } from '../../oracle/types.js';
import { setupOwaspVendor, readOwaspVendorLock } from './setup.js';
import { readExpectedResults, sampleRepresentative, type OwaspTestCase } from './tasks.js';

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
      // Classification benchmark: grade the adversarial gate's confirmed/rejected call against
      // expectedresults-1.2.csv rather than spending on full exploitation/triage/disclosure for
      // every one of ~2,740 single-servlet test cases (see autobrin-flue#182).
      detectOnly: true,
      metadata: {
        ...testCase,
        changedPaths: [testCase.javaSourcePath],
      },
    };
  },

  async score(input: { task: BenchmarkTask; claim: ContenderClaim }): Promise<OracleScore> {
    const testCase = input.task.metadata as OwaspTestCase;
    return scoreOwaspVerdict(testCase, input.claim);
  },
};

/**
 * True when a confirmed finding's location plausibly refers to this test case's own servlet,
 * OR when the finding carries no location at all. The "no location" fallback matters because
 * the two contenders give genuinely asymmetric information here: AutoBrin's detect-only mode
 * (see `standUpTarget` above) stops right after the adversarial gate, before the
 * exploitation/disclosure stages that would otherwise populate `report.affected_component` --
 * every AutoBrin `ConfirmedFinding` for this benchmark has `location: undefined`, so treating
 * "no location" as non-matching would silently score every AutoBrin true positive as a false
 * negative. PITHOS's findings, by contrast, do carry real file paths (`contenders/pithos.ts`
 * joins `finding.files`), so for PITHOS this filter does real work: confirmed against a real
 * OWASP repo of ~2,740 files, a live run found PITHOS reporting genuine but unrelated
 * vulnerabilities elsewhere in the Benchmark's own test harness (hardcoded LDAP/keystore
 * passwords) while scoring a single-servlet task -- without this check those would have been
 * misattributed as a false positive for that task instead of correctly ignored.
 */
function findingLooksRelevant(finding: ConfirmedFinding, testCase: OwaspTestCase): boolean {
  if (!finding.location) return true;
  const normalized = finding.location.replace(/\\/g, '/').toLowerCase();
  return normalized.includes(testCase.javaSourcePath.toLowerCase()) || normalized.includes(testCase.testName.toLowerCase());
}

/**
 * Grades a contender's own confirmed/rejected classification for one test case against
 * `expectedresults-1.2.csv` ground truth (`testCase.vulnerable`) -- the adversarial gate's
 * confirmed/rejected call under detect-only mode *is* the classification signal, exactly like
 * any other SAST tool being graded by this same Benchmark. `confirmedFindings` is populated
 * identically by both contenders: AutoBrin from `evaluate.json`'s `verdict`
 * (`composeDetectOnlyVerdict` in autobrin-flue), PITHOS from its own static/runtime verdict
 * merge (`contenders/pithos.ts`'s `normalizeVerdict`) -- so this one mapping covers both without
 * a contender-specific branch.
 */
export function scoreOwaspVerdict(testCase: OwaspTestCase, claim: ContenderClaim): OracleScore {
  const confirmed = claim.confirmedFindings.some((finding) => findingLooksRelevant(finding, testCase));
  const label = `${testCase.testName} (${testCase.category}, CWE-${testCase.cwe})`;
  const metadata = { testName: testCase.testName, category: testCase.category, cwe: testCase.cwe };

  if (testCase.vulnerable && confirmed) {
    return {
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      trueNegatives: 0,
      signals: [{ outcome: 'true_positive', matched: true, reason: `Contender confirmed ${label}, matching real vulnerability ground truth`, metadata }],
    };
  }
  if (testCase.vulnerable && !confirmed) {
    return {
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 1,
      trueNegatives: 0,
      signals: [{ outcome: 'false_negative', matched: false, reason: `Contender did not confirm ${label}, but ground truth marks it a real vulnerability`, metadata }],
    };
  }
  if (!testCase.vulnerable && confirmed) {
    return {
      truePositives: 0,
      falsePositives: 1,
      falseNegatives: 0,
      trueNegatives: 0,
      signals: [{ outcome: 'false_positive', matched: false, reason: `Contender confirmed ${label}, but ground truth marks it a false-positive trap (not vulnerable)`, metadata }],
    };
  }
  return {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    trueNegatives: 1,
    signals: [{ outcome: 'true_negative', matched: true, reason: `Contender correctly did not confirm ${label}, matching ground truth (not vulnerable)`, metadata }],
  };
}
