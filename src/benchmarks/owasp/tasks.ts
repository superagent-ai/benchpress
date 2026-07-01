import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * OWASP Benchmark for Java v1.2 test case, parsed from `expectedresults-1.2.csv`
 * (verified against the real file in OWASP-Benchmark/BenchmarkJava@56f8b33f).
 * Ground truth format: `# test name, category, real vulnerability, cwe, ...`
 * e.g. `BenchmarkTest00001,pathtraver,true,22`.
 */
export type OwaspTestCase = {
  testName: string;
  category: string;
  cwe: number;
  vulnerable: boolean;
  /** Every test case is a single flat-file servlet at this fixed path (verified for all 2,740 cases). */
  javaSourcePath: string;
};

export const OWASP_EXPECTED_RESULTS_FILE = 'expectedresults-1.2.csv';
const TESTCODE_DIR = 'src/main/java/org/owasp/benchmark/testcode';

/**
 * Parses the real, simple (unquoted, no embedded commas) CSV format shipped by
 * OWASP Benchmark for Java. Comment/header lines start with `#`.
 */
export function parseExpectedResultsCsv(csvText: string): OwaspTestCase[] {
  const cases: OwaspTestCase[] = [];
  for (const rawLine of csvText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const [testName, category, vulnerableRaw, cweRaw] = line.split(',').map((field) => field.trim());
    if (!testName || !category || !vulnerableRaw || !cweRaw) continue;
    const cwe = Number.parseInt(cweRaw, 10);
    if (Number.isNaN(cwe)) continue;
    cases.push({
      testName,
      category,
      cwe,
      vulnerable: vulnerableRaw.toLowerCase() === 'true',
      javaSourcePath: `${TESTCODE_DIR}/${testName}.java`,
    });
  }
  return cases;
}

export async function readExpectedResults(vendorRoot: string): Promise<OwaspTestCase[]> {
  const text = await readFile(path.join(vendorRoot, OWASP_EXPECTED_RESULTS_FILE), 'utf8');
  return parseExpectedResultsCsv(text);
}

/**
 * Deterministic representative sample for the scale guardrail (20-50 cases,
 * not all ~2,740): takes the first `perGroup` cases for each (category, vulnerable)
 * pair, in ascending test-number order. Every v1.2 category has both true-vuln and
 * FP-trap cases (verified: smallest group is xpathi/false at 20), so this always
 * yields a balanced spread with no randomness, which keeps runs reproducible and
 * easy to spot-check by hand. Default `perGroup=2` over 11 categories x 2 labels
 * yields 44 tasks. To scale up, raise `perGroup` (e.g. 4 -> 88) or drop the cap
 * entirely by calling `parseExpectedResultsCsv`/`readExpectedResults` directly.
 */
export function sampleRepresentative(cases: OwaspTestCase[], perGroup = 2): OwaspTestCase[] {
  const seenCounts = new Map<string, number>();
  const sample: OwaspTestCase[] = [];
  for (const testCase of cases) {
    const key = `${testCase.category}:${testCase.vulnerable}`;
    const count = seenCounts.get(key) ?? 0;
    if (count >= perGroup) continue;
    seenCounts.set(key, count + 1);
    sample.push(testCase);
  }
  return sample;
}
