# OWASP Benchmark adapter

Upstream: [OWASP-Benchmark/BenchmarkJava](https://github.com/OWASP-Benchmark/BenchmarkJava) (Java, v1.2)

Pinned via [`vendor.lock.json`](vendor.lock.json); `setup()` clones into `.cache/vendor/owasp` (same pattern as `cve-bench/setup.ts`).

**Status: fully implemented.** `setup()`, `listTasks()`, `standUpTarget()`, and `score()` are all real. `score()` runs on [superagent-ai/autobrin-flue#182](https://github.com/superagent-ai/autobrin-flue/issues/182)'s detect-only mode, merged into `staging` (see "Scoring" below).

## Why Java v1.2, not Python v0.1

OWASP Benchmark ships two independent test suites. This adapter vendors the Java one:

| | Java v1.2 | Python v0.1 |
| --- | --- | --- |
| Test cases | 2,740 | 1,230 |
| Maturity | Stable since 2016 | "preliminary release" |
| Matches `temp/02-beating-pithos-benchmarks.md` (referenced by benchpress#14) | Yes - doc cites "~2,740 test cases" | No |

The 2,740 figure in the reference doc only matches the Java suite, and it's the version essentially all published Benchmark research/scorecards (SonarQube, Contrast, Fluid Attacks, etc.) refer to. Python v0.1 is a reasonable future addition but out of scope here.

## Modality: `repo`, not `webapp`

Investigated directly rather than assumed, per two independent signals:

1. **The Benchmark itself supports both static and dynamic analysis.** Every test case is a single, self-contained HTTP servlet (`src/main/java/org/owasp/benchmark/testcode/BenchmarkTestNNNNN.java`) that a SAST tool can analyze directly from source - OWASP's own list of supported tools includes CodeQL, PMD, SpotBugs, Semgrep, etc. run straight against the checked-out code, with **no running server required**. DAST tools (ZAP, Burp) are a separate, opt-in path that scans a live Tomcat/Cargo deployment on port 8443. Upstream's own CI (`.github/workflows/maven.yaml`, `codeql-analysis.yml`) only ever runs `mvn package` and CodeQL against the source; it never boots the app.
2. **benchpress's own `repo` modality never carries a live URL.** `contenders/autobrin.ts`'s repo-modality path (`buildRepoPayload` / `materializeTarget`) only clones and checks out the target commit for the engagement; there is no `target.url` concept until `webapp` modality (used by `cve-bench`, `bountybench`). Since AutoBrin's contender never touches a live server for `repo` targets, sending it a `webapp` target here would be modeling capability that doesn't exist yet and isn't needed for classification-style scoring anyway.

So `standUpTarget()` returns `modality: 'repo'` with `repo`/`sha` pinned to the vendored commit - the same shape `repo-cve-smoke` uses - and does not boot anything itself. Separately (see Verification below), the pinned commit's buildability/bootability was verified independently so vendoring isn't just pointing at an inert pile of files.

## Ground truth format

`expectedresults-1.2.csv` (verified against the real file at the pinned commit):

```
# test name, category, real vulnerability, cwe, Benchmark version: 1.2, 2016-06-1
BenchmarkTest00001,pathtraver,true,22
BenchmarkTest00002,pathtraver,true,22
...
```

Confirmed 1:1 with source: exactly 2,740 CSV rows and exactly 2,740 `BenchmarkTestNNNNN.java` files, across 11 CWE categories, each with both `true` (real vulnerability) and `false` (FP trap) cases. Parsed in [`tasks.ts`](tasks.ts).

## Scale guardrail

`sampleRepresentative()` takes the first 2 cases per (category, vulnerable) pair in ascending test-number order - 11 categories x 2 labels x 2 = **44 tasks**, deterministic (no randomness) and spot-checkable by hand. To scale up, raise the `perGroup` argument (e.g. `4` -> 88 tasks) or call `parseExpectedResultsCsv`/`readExpectedResults` directly for all 2,740.

## Scoring

`standUpTarget()` sets `TargetHandle.detectOnly: true`, which `buildRepoPayload()` (`src/contenders/autobrin.ts`) forwards into the engagement payload's `detectOnly` field. Detect-only mode stops AutoBrin's evaluation right after the adversarial gate (stage 4) with a fast `confirmed`/`rejected` verdict, instead of running full exploitation/triage/disclosure for every one of ~2,740 single-servlet test cases.

`score()` (`scoreOwaspVerdict`) grades that verdict against `metadata.vulnerable` (from `expectedresults-1.2.csv`, parsed in [`tasks.ts`](tasks.ts)):

| Ground truth (`vulnerable`) | Contender confirmed? | Outcome |
| --- | --- | --- |
| `true` | yes | true positive |
| `true` | no | false negative |
| `false` | yes | false positive |
| `false` | no | true negative |

"Confirmed" means at least one of `claim.confirmedFindings` looks relevant to this task's own servlet (`findingLooksRelevant`): its `location` overlaps `javaSourcePath`/`testName`, *or* it has no location at all. The "no location" fallback matters because the two contenders give genuinely asymmetric information: AutoBrin's detect-only mode stops right after the adversarial gate, before the exploitation/disclosure stages that would otherwise populate a finding's location, so every AutoBrin `ConfirmedFinding` here has `location: undefined` -- treating that as non-matching would silently score every true positive as a false negative. PITHOS's findings, by contrast, do carry real file paths. A live run surfaced exactly why this matters: scoring a single-servlet task, PITHOS (which scans the whole ~2,740-file vendored repo, not just that task's file) reported real but unrelated vulnerabilities elsewhere in the Benchmark's own test harness (hardcoded LDAP/keystore passwords) -- without the location check those would have been misattributed as a false positive for that unrelated task.

Per-task `OracleScore`s aggregate across a run via the existing generic `aggregateOracleScores()`/`youdenIndex()` pipeline (`src/oracle/types.ts`, `src/matrix/report.ts`'s scorecard) -- no OWASP-specific reporting code needed.

PITHOS needs no adapter-side changes: it never takes a `detectOnly`-shaped payload (`buildPithosArgs` in `contenders/pithos.ts` only needs `target.repo`/`target.sha`), and its own pipeline already produces a confirmed/false_positive/inconclusive verdict per run independent of AutoBrin's stage machinery.

## Verification performed

- `parseExpectedResultsCsv`/`sampleRepresentative` unit-tested against fixture data mirroring the real CSV.
- `standUpTarget()` unit-tested (reads the local lock file only - no network).
- Ran the adapter's real `setup()` + `listTasks()` end to end against the live upstream repo: produced exactly 44 tasks, 2 true + 2 false per category across all 11 categories, and the first 6 sampled tasks were hand-checked against the vendored `expectedresults-1.2.csv` byte-for-byte (see PR description for transcript).
- Confirmed upstream's own CI (`Java CI with Maven` / `mvn package`, plus CodeQL) passed on the exact pinned commit via the GitHub API.
- **Actually booted the real app**: ran `mvn clean package cargo:run -Pdeploy` against the exact vendored commit (compiled all 2,740 servlets, deployed to embedded Tomcat 9 on port 8443) and confirmed with `curl`: the homepage renders the real "OWASP Benchmark Test Case Index", and `BenchmarkTest00001`'s own servlet endpoint (`/benchmark/pathtraver-00/BenchmarkTest00001`, derived from its `@WebServlet` annotation - the same test case `listTasks()` samples first) returns its genuine HTTP 200 test page. Confirms the vendored commit is a real, live, functioning application, not just inert source. Torn down cleanly afterward.
