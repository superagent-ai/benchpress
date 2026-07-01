import { describe, expect, it } from 'vitest';
import { parseExpectedResultsCsv, sampleRepresentative } from '../src/benchmarks/owasp/tasks.js';
import { readOwaspVendorLock } from '../src/benchmarks/owasp/setup.js';
import { owaspAdapter } from '../src/benchmarks/owasp/adapter.js';
import { NotImplementedBenchmarkError } from '../src/benchmarks/types.js';
import type { BenchmarkTask } from '../src/contenders/types.js';

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
    expect(target.metadata?.changedPaths).toEqual([
      'src/main/java/org/owasp/benchmark/testcode/BenchmarkTest00001.java',
    ]);
    expect(target.metadata?.vulnerable).toBe(true);
  });

  it('score() throws NotImplementedBenchmarkError pointing at autobrin-flue#182, not a faked result', () => {
    const task: BenchmarkTask = { id: 'BenchmarkTest00001', benchmarkId: 'owasp' };
    const target = { benchmarkId: 'owasp', taskId: 'BenchmarkTest00001', modality: 'repo' as const };
    const claim = { confirmedFindings: [], selfVerdictCounts: {}, triageCounts: {} };

    expect(() => owaspAdapter.score({ task, target, claim })).toThrow(NotImplementedBenchmarkError);
    try {
      owaspAdapter.score({ task, target, claim });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedBenchmarkError);
      expect((error as Error).message).toContain('182');
    }
  });
});
