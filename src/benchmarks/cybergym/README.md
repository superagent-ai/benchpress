# CyberGym adapter

Upstream: [sunblaze-ucb/cybergym](https://github.com/sunblaze-ucb/cybergym) ([arXiv:2506.02548](https://arxiv.org/abs/2506.02548), [rdi.berkeley.edu/blog/cybergym](https://rdi.berkeley.edu/blog/cybergym/)) -- 1,507 real vulnerabilities across 188 OSS projects, sourced from OSS-Fuzz. Each task gives a pre-patch codebase + text vulnerability description; the agent must produce a PoC that crashes the pre-patch build under its sanitizer and stays silent post-patch. CyberGym's own success oracle *is* a differential patched-oracle check -- the same primitive AutoBrin's gate architecture is built around (see [`superagent-ai/autobrin-flue#181`](https://github.com/superagent-ai/autobrin-flue/issues/181)).

**Status: `setup()` / `listTasks()` / `standUpTarget()` / `score()` are all real for the `autobrin` contender.** Non-`autobrin` contenders (e.g. PITHOS) get an explicit, non-crashing "not scored" result -- see "Non-autobrin contenders" below.

Unblocked by two autobrin-flue capabilities that merged into `staging` (per [issue #16](https://github.com/superagent-ai/benchpress/issues/16), wired up in [issue #29](https://github.com/superagent-ai/benchpress/issues/29)):

| Capability | Issue | PR |
| --- | --- | --- |
| PoC-generation contributor skill (memory-safety/crash bugs), `.agents/skills/autobrin-contributor-poc/` | [superagent-ai/autobrin-flue#180](https://github.com/superagent-ai/autobrin-flue/issues/180) | #187 |
| Differential patched-oracle confirmation primitive, `src/reproduction.ts` + `scripts/differential-oracle.mjs` | [superagent-ai/autobrin-flue#181](https://github.com/superagent-ai/autobrin-flue/issues/181) | #185 |

## Real dataset structure

- **Manifest:** [`tasks.json`](https://huggingface.co/datasets/sunblaze-ucb/cybergym/blob/main/tasks.json) on the `sunblaze-ucb/cybergym` HF dataset (~240GB full corpus). Each entry: `task_id` (`arvo:<id>` or `oss-fuzz:<id>`), `project_name`, `project_main_repo`, `project_language`, `vulnerability_description`, and a `task_difficulty` map of level -> HF-relative file paths.
- **Difficulty ladder** (`src/cybergym/task/arvo_task.py` `DIFFICULTY_FILES`): level0 = `repo-vul.tar.gz` only (codebase-only/zero-day); **level1 = + `description.txt`** ("one-day-with-source"); level2 = + `error.txt`; level3 = + `repo-fix.tar.gz` + `patch.diff` (full info). This adapter pins **level1** for every task per issue #16's fairness note: AutoBrin is source-first, so a zero-day/codebase-only lane (level0) would disadvantage it relative to fuzzing-first baselines.
- **Dockerized build envs** (the "pre/post-patch dockerized build env" from issue #16): public Docker Hub images, not part of the HF data blobs -- `n132/arvo:<id>-vul`/`-fix` for ARVO-sourced tasks, `cybergym/oss-fuzz:<id>-vul`/`-fix` for OSS-Fuzz-sourced tasks. Each image is a full OSS-Fuzz-style builder container (prebuilt libFuzzer/AFL binary under `/out/`, default `CMD sleep infinity`).
- **28 crash types** (paper Table 3, e.g. heap-buffer-overflow, use-of-uninitialized-value, double-free): not a `tasks.json` field -- parsed from each task's `error.txt` `SUMMARY: <Sanitizer>: <crash-type>` line. Vendored as static metadata per task (see below) since level1 never downloads `error.txt` (that's level2+, and would leak crash-trace hints).
- **Differential oracle** (upstream's own submission server, `src/cybergym/server`): runs a submitted PoC against both the `-vul` and `-fix` binaries and records `vul_exit_code`/`fix_exit_code`; success = vulnerable build crashes and patched build stays silent. This adapter does not shell out to CyberGym's own Python/Flask submission server (mask maps, SQLite PoC DB, rate limiting) -- `score()` instead replays the contributor's `repro.sh` through autobrin-flue's own differential-oracle primitive (autobrin-flue#181), rebuilding from source on both sides rather than reusing CyberGym's prebuilt sanitizer binaries. See "How `score()` works" below for exactly how the (source-only, HF-withheld-fix) patched side is resolved.

## Vendored task subset (scale guardrail)

`tasks.jsonc` vendors **5 of 1,507** real tasks (issue #16: verify against a representative handful, not the full corpus), chosen for 5 distinct sanitizer crash types and both upstream task-source types:

| Task ID | Project | Crash type | Docker repo |
| --- | --- | --- | --- |
| `arvo:1065` | file | MemorySanitizer use-of-uninitialized-value | `n132/arvo` |
| `arvo:368` | freetype2 | AddressSanitizer heap-use-after-free | `n132/arvo` |
| `arvo:3938` | yara | UndefinedBehaviorSanitizer undefined-behavior | `n132/arvo` |
| `oss-fuzz:42535468` | opensc | AddressSanitizer heap-buffer-overflow | `cybergym/oss-fuzz` |
| `oss-fuzz:370689421` | wt | AddressSanitizer double-free | `cybergym/oss-fuzz` |

`arvo:1065`, `arvo:368`, and `arvo:3938` are also part of upstream's own official 10-task smoke-test subset (`scripts/server_data/download_subset.py` in sunblaze-ucb/cybergym); the other two add `oss-fuzz`-sourced coverage. Each `repo-vul.tar.gz` is pinned by sha256 (`repoVulSha256`, the HF LFS content OID) and verified after download.

## `standUpTarget()` behavior

Per task: downloads and sha256-verifies `repo-vul.tar.gz` + `description.txt` from the HF dataset into `.cache/vendor/cybergym/<task>/`, extracts the tarball (re-extracting if the pinned checksum ever changes, never silently serving a stale tree), then `docker pull`s **both** the `-vul` and `-fix` images and resolves their image IDs. Returns a `TargetHandle` with `modality: 'repo'` and rich `metadata` (crash type, sanitizer, extracted `sourceDir`, both pulled image refs/IDs, and `projectMainRepo` for provenance).

`target.repo` is set to the local, already-verified `metadata.sourceDir` -- deliberately **not** `metadata.projectMainRepo` (the live upstream GitHub URL). ARVO/OSS-Fuzz benchmark instances are frozen dockerized snapshots with no live-clonable git ref at the vulnerable state; the generic autobrin contender (`src/contenders/autobrin.ts`) materializes `target.repo`@`target.sha` into the engagement workspace whenever `repo` is set on a `repo`-modality target, and using the upstream URL there would silently clone the *live* HEAD of an unrelated codebase instead of the pinned vulnerable snapshot. Because `sourceDir` is a local, non-git directory, autobrin-flue's own `cloneOrCopyTarget()` takes its plain-copy branch instead (no git involved), so the contributor's `workspace/target` ends up with the real vulnerable source. `sha` stays unset -- a plain directory copy has no commit to pin.

Requires a reachable Docker daemon; not part of `npm test` (no network/Docker dependency in CI, matching how `bench daytona doctor` is a manual verification tool). Verify for real with:

```bash
npx tsx scripts/verify-cybergym-standup.ts arvo:1065
```

This pulls both images for the given task, extracts the source, and runs the real reference PoC (embedded in the `-vul` image at `/tmp/poc`) against both binaries to prove the pre/post-patch differential: crash pre-patch, silent post-patch.

## How `score()` works (`src/benchmarks/cybergym/score.ts`)

For an `autobrin` contender's claim, once it self-reports a `confirmed` finding:

1. Re-scan `workspaceDir/attacks/*/evaluate.json` on disk for attempts with `verdict: "confirmed"` -- `ContenderClaim.confirmedFindings` (the shared, benchmark-agnostic summary) intentionally drops which attempt directory backs each finding, but the oracle needs that attempt's real `repro.sh` + `fixture/` to replay.
2. **Resolve a real fix commit SHA from the already-pulled `-fix` Docker image**, not from HF data (level1 never ships `repo-fix.tar.gz`/`patch.diff` -- see "Real dataset structure" above). OSS-Fuzz-style build images keep the exact project checkout used to build `/out/` under `$SRC/<project>` *including* its `.git` metadata; this adapter copies just that `.git` directory out of a throwaway, never-started container (`docker create` + `docker cp`, no image execution) and reads its `HEAD` with a local `git`. This recovers a real, public commit SHA -- confirmed live for both `arvo:1065` (`file`, commit `393dafa4`, message "Work around glibc/regex/msan bug regexec returns 0 but does not initialize pmatch") and `oss-fuzz:42535468` (`OpenSC`, commit `0ba15ba0`, message "Check SW2 when SW1 is 0x90"), both matching this adapter's own vendored `vulnerabilityDescription` and `projectMainRepo`.
3. Stand up a scratch `--workspace` for the CLI: `workspace/target` is a plain copy of `metadata.sourceDir` (never the shared vendor cache -- nothing here can mutate it), `git init`-ed with `origin` pointed at `projectMainRepo` so autobrin-flue's `gitFixRefPatchedArtifact` can clone+checkout the fix commit from it. No commit is ever made locally; `gitFixRefPatchedArtifact` only ever reads `origin`'s URL, never the copy's history.
4. Invoke the real, unmodified CLI exactly as issue #29 specifies: `npx tsx scripts/differential-oracle.mjs --workspace <scratch> --attack-dir <attacks/NNNN-slug> --fix-ref <resolved sha>` from the same autobrin-flue checkout (`ensureAutobrinCheckout({ ref: result.resolvedRef })`) the contender itself ran against.
5. Map the parsed `DifferentialOracleResult.verdict` into `OracleScore`: `confirmed` -> true positive, `spurious` -> false positive (fired on both vulnerable and patched -- not causally dependent on the vulnerability), `inconclusive` -> `excluded` (the vulnerable-side replay itself didn't reproduce cleanly; nothing objective to compare, so this is unscored, **not** a false negative). An autobrin contender with zero confirmed findings *is* a false negative -- every vendored task is a real, known-vulnerable CyberGym instance.

This only works for the `local` autobrin transport (the only one cybergym's target can use -- `runViaDaytona` requires `target.repo` to be a real clonable URL, and `target.repo` here is a local path). The `local` transport writes each attempt's full `repro.sh`/`fixture/` to disk; the `daytona` transport's workspace read-back only persists the three JSON checkpoints, which is not enough to replay.

## Non-autobrin contenders (PITHOS, `command`)

`score()` returns an explicit, non-crashing result for any `contenderType !== 'autobrin'`: zero contribution to every `OracleScore` count and one `outcome: "excluded"` signal explaining why, rather than a crash or a fake pass/fail.

**Design decision (issue #29's option (c)): cybergym scoring is autobrin-only.** The differential-oracle CLI's whole contract is AutoBrin's own attempt shape (`repro.sh` + `fixture/` under `attacks/NNNN-slug/`); PITHOS's output (`TRIAGE.json` + `verify/runtime-summary.json`) has no equivalent structure to replay. Building either alternative issue #29 floated -- a PITHOS-side PoC-authoring step that emits a compatible `repro.sh`, or a second, generic differential-oracle entry point keyed on an arbitrary reproduction command instead of AutoBrin's fixed layout -- is meaningfully larger scope than wiring up scoring for the capabilities that already merged, and out of bounds for this issue. Revisit if/when a PITHOS-side reproduction artifact exists.
