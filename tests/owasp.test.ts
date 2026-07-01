import { describe, expect, it } from 'vitest';
import { parseExpectedResultsCsv, sampleRepresentative } from '../src/benchmarks/owasp/tasks.js';
import { readOwaspVendorLock } from '../src/benchmarks/owasp/setup.js';
import { owaspAdapter, scoreOwaspVerdict } from '../src/benchmarks/owasp/adapter.js';
import type { BenchmarkTask, ContenderClaim } from '../src/contenders/types.js';

// Mirrors the real expectedresults-1.2.csv format, verified against
// OWASP-Benchmark/BenchmarkJava@56f8b33f. BenchmarkTest00006 exists to exercise
// the sampleRepresentative cap (a 3rd sqli/true case that should be excluded).
const FIXTURE_CSV = `# test name, category, real vulnerability, cwe, Benchmark version: 1.2, 2016-06-1
BenchmarkTest00001,pathtraver,true,22
BenchmarkTest00002,pathtraver,false,22
BenchmarkTest00003,sqli,true,89
BenchmarkTest00004,sqli,false,89
BenchmarkTest00005,sqli,true,89
BenchmarkTest00006,sqli,true,89

`;

describe('owasp CSV parsing', () => {
  it('parses real expectedresults-1.2.csv format, skipping the comment header and blank lines', () => {
    const cases = parseExpectedResultsCsv(FIXTURE_CSV);
    expect(cases).toHaveLength(6);
    expect(cases[0]).toEqual({
      testName: 'BenchmarkTest00001',
      category: 'pathtraver',
      cwe: 22,
      vulnerable: true,
      javaSourcePath: 'src/main/java/org/owasp/benchmark/testcode/BenchmarkTest00001.java',
    });
  });

  it('maps "false" to vulnerable: false', () => {
    const cases = parseExpectedResultsCsv(FIXTURE_CSV);
    const trap = cases.find((c) => c.testName === 'BenchmarkTest00002');
    expect(trap?.vulnerable).toBe(false);
  });

  it('derives the fixed flat testcode source path for every case', () => {
    const cases = parseExpectedResultsCsv(FIXTURE_CSV);
    for (const testCase of cases) {
      expect(testCase.javaSourcePath).toBe(
        `src/main/java/org/owasp/benchmark/testcode/${testCase.testName}.java`,
      );
    }
  });
});

describe('owasp representative sampling', () => {
  it('caps each (category, vulnerable) group at perGroup, preserving CSV order', () => {
    const cases = parseExpectedResultsCsv(FIXTURE_CSV);
    const sample = sampleRepresentative(cases, 2);
    const names = sample.map((c) => c.testName);
    expect(names).toEqual([
      'BenchmarkTest00001',
      'BenchmarkTest00002',
      'BenchmarkTest00003',
      'BenchmarkTest00004',
      'BenchmarkTest00005',
    ]);
    expect(names).not.toContain('BenchmarkTest00006');
  });

  it('includes both true-vuln and FP-trap labels in the sample', () => {
    const cases = parseExpectedResultsCsv(FIXTURE_CSV);
    const sample = sampleRepresentative(cases, 2);
    expect(sample.some((c) => c.vulnerable)).toBe(true);
    expect(sample.some((c) => !c.vulnerable)).toBe(true);
  });

  it('yields 44 tasks for the real 11-category x 2-label shape at the default perGroup', () => {
    const categories = ['cmdi', 'crypto', 'hash', 'ldapi', 'pathtraver', 'securecookie', 'sqli', 'trustbound', 'weakrand', 'xpathi', 'xss'];
    const synthetic = categories.flatMap((category, i) => [
      { testName: `T${i}a`, category, cwe: 1, vulnerable: true, javaSourcePath: '' },
      { testName: `T${i}b`, category, cwe: 1, vulnerable: true, javaSourcePath: '' },
      { testName: `T${i}c`, category, cwe: 1, vulnerable: true, javaSourcePath: '' },
      { testName: `T${i}d`, category, cwe: 1, vulnerable: false, javaSourcePath: '' },
      { testName: `T${i}e`, category, cwe: 1, vulnerable: false, javaSourcePath: '' },
      { testName: `T${i}f`, category, cwe: 1, vulnerable: false, javaSourcePath: '' },
    ]);
    expect(sampleRepresentative(synthetic)).toHaveLength(44);
  });
});

describe('owasp adapter', () => {
  it('is registered as scientific lane', () => {
    expect(owaspAdapter.id).toBe('owasp');
    expect(owaspAdapter.lane).toBe('scientific');
  });

  it('standUpTarget returns repo modality pinned to the vendored commit (no network needed)', async () => {
    const lock = await readOwaspVendorLock();
    const task: BenchmarkTask = {
      id: 'BenchmarkTest00001',
      benchmarkId: 'owasp',
      metadata: {
        testName: 'BenchmarkTest00001',
        category: 'pathtraver',
        cwe: 22,
        vulnerable: true,
        javaSourcePath: 'src/main/java/org/owasp/benchmark/testcode/BenchmarkTest00001.java',
      },
    };

    const target = await owaspAdapter.standUpTarget(task);

    expect(target.modality).toBe('repo');
    expect(target.repo).toBe(lock.repo);
    expect(target.sha).toBe(lock.commit);
    expect(target.taskId).toBe('BenchmarkTest00001');
    expect(target.detectOnly).toBe(true);
    expect(target.metadata?.changedPaths).toEqual([
      'src/main/java/org/owasp/benchmark/testcode/BenchmarkTest00001.java',
    ]);
    expect(target.metadata?.vulnerable).toBe(true);
  });

  it('score() maps a confirmed verdict against real ground truth into an OracleScore, not a thrown error', async () => {
    const task: BenchmarkTask = {
      id: 'BenchmarkTest00001',
      benchmarkId: 'owasp',
      metadata: { testName: 'BenchmarkTest00001', category: 'pathtraver', cwe: 22, vulnerable: true, javaSourcePath: '' },
    };
    const target = { benchmarkId: 'owasp', taskId: 'BenchmarkTest00001', modality: 'repo' as const };
    const claim: ContenderClaim = { confirmedFindings: [{ verdict: 'confirmed' }], selfVerdictCounts: { confirmed: 1 }, triageCounts: {} };

    const score = await owaspAdapter.score({ task, target, claim });
    expect(score.truePositives).toBe(1);
  });
});

describe('scoreOwaspVerdict', () => {
  const vulnerable = { testName: 'BenchmarkTest00001', category: 'pathtraver', cwe: 22, vulnerable: true, javaSourcePath: '' };
  const notVulnerable = { testName: 'BenchmarkTest00002', category: 'pathtraver', cwe: 22, vulnerable: false, javaSourcePath: '' };
  const confirmedClaim: ContenderClaim = { confirmedFindings: [{ verdict: 'confirmed' }], selfVerdictCounts: { confirmed: 1 }, triageCounts: {} };
  const rejectedClaim: ContenderClaim = { confirmedFindings: [], selfVerdictCounts: { rejected: 1 }, triageCounts: {} };

  it('scores a true positive: real vulnerability, contender confirmed', () => {
    const score = scoreOwaspVerdict(vulnerable, confirmedClaim);
    expect(score).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0, trueNegatives: 0 });
    expect(score.signals[0]?.outcome).toBe('true_positive');
  });

  it('scores a false negative: real vulnerability, contender rejected', () => {
    const score = scoreOwaspVerdict(vulnerable, rejectedClaim);
    expect(score).toMatchObject({ truePositives: 0, falsePositives: 0, falseNegatives: 1, trueNegatives: 0 });
    expect(score.signals[0]?.outcome).toBe('false_negative');
  });

  it('scores a false positive: FP-trap case, contender confirmed', () => {
    const score = scoreOwaspVerdict(notVulnerable, confirmedClaim);
    expect(score).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 0, trueNegatives: 0 });
    expect(score.signals[0]?.outcome).toBe('false_positive');
  });

  it('scores a true negative: FP-trap case, contender rejected', () => {
    const score = scoreOwaspVerdict(notVulnerable, rejectedClaim);
    expect(score).toMatchObject({ truePositives: 0, falsePositives: 0, falseNegatives: 0, trueNegatives: 1 });
    expect(score.signals[0]?.outcome).toBe('true_negative');
  });

  it('treats an empty claim (no attempts confirmed) the same as an explicit rejection', () => {
    const emptyClaim: ContenderClaim = { confirmedFindings: [], selfVerdictCounts: {}, triageCounts: {} };
    expect(scoreOwaspVerdict(vulnerable, emptyClaim).falseNegatives).toBe(1);
    expect(scoreOwaspVerdict(notVulnerable, emptyClaim).trueNegatives).toBe(1);
  });

  it("matches PITHOS's confirmed verdict the same way as AutoBrin's when the location overlaps the task's file", () => {
    // contenders/pithos.ts's normalizeVerdict also lands on the literal string 'confirmed'.
    const pithosClaim: ContenderClaim = {
      confirmedFindings: [{ location: 'src/main/java/org/owasp/benchmark/testcode/BenchmarkTest00001.java', verdict: 'confirmed' }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: { high: 1 },
    };
    expect(scoreOwaspVerdict({ ...vulnerable, javaSourcePath: 'src/main/java/org/owasp/benchmark/testcode/BenchmarkTest00001.java' }, pithosClaim).truePositives).toBe(1);
  });

  it("treats AutoBrin's detect-only confirmed findings (no location field) as relevant, since that mode never populates one", () => {
    // Real shape from computeClaimFromAttempts (contenders/autobrin.ts): detect-only mode stops
    // before the exploitation/disclosure stages that would otherwise populate report.location.
    const autobrinClaim: ContenderClaim = {
      confirmedFindings: [{ location: undefined, cve: undefined, summary: 'some finding', verdict: 'confirmed' }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: {},
    };
    expect(scoreOwaspVerdict(vulnerable, autobrinClaim).truePositives).toBe(1);
  });

  it('does not misattribute a confirmed finding about a different file in the repo (real shape observed live from PITHOS)', () => {
    // PITHOS scans the whole ~2,740-file vendored repo, not just this task's one servlet. A live
    // run against BenchmarkTest00063 (pathtraver, not vulnerable) had PITHOS correctly find real,
    // but unrelated, hardcoded-credential issues elsewhere in the Benchmark's own test harness --
    // this must not count as a false positive for BenchmarkTest00063.
    const unrelatedFindingsClaim: ContenderClaim = {
      confirmedFindings: [
        { location: 'src/main/java/org/owasp/benchmark/helpers/LDAPManager.java', summary: 'hardcoded LDAP admin password', verdict: 'confirmed' },
        { location: 'pom.xml, src/config/local/server.xml, .keystore', summary: 'hardcoded SSL keystore password', verdict: 'confirmed' },
      ],
      selfVerdictCounts: { confirmed: 2 },
      triageCounts: { medium: 1, low: 1 },
    };
    const notVulnerablePathtraver = { testName: 'BenchmarkTest00063', category: 'pathtraver', cwe: 22, vulnerable: false, javaSourcePath: 'src/main/java/org/owasp/benchmark/testcode/BenchmarkTest00063.java' };
    expect(scoreOwaspVerdict(notVulnerablePathtraver, unrelatedFindingsClaim).trueNegatives).toBe(1);
  });
});
