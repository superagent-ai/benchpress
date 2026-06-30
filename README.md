# benchpress

**N contenders × Y benchmarks** competition harness for security agents. AutoBrin is one contender (consumed as a black box via `flue run engagement`); any other agent plugs in as a config-driven command contender. The **benchmark grader** is the score — never a contender's self-verdict.

## Quick start

```bash
cd ~/Documents/code/benchpress
npm install
npm run validate

# List registered benchmarks
npm run bench -- list

# Compare autobrin-flue staging vs main (dev-smoke lane)
dotenvx run -f ~/.config/secrets/global.env -- npm run bench -- matrix --config config/matrix.example.jsonc
```

## What it does

For each task, benchpress:

1. Stands up **one** target (fairness invariant)
2. Fans the same target out to all contenders with identical model / budget / info level
3. Maps each benchmark's native grader into a normalized objective signal
4. Emits a head-to-head scorecard (TP/FP/FN, Youden, claim-vs-grader gap, cost)

Version-vs-version comparisons (e.g. `autobrin@staging` vs `autobrin@main`) use the same machinery — multiple `autobrin` contenders differing only by `ref` or `path`.

## Contenders

| Type | Purpose |
| --- | --- |
| `autobrin` | Clones [superagent-ai/autobrin-flue](https://github.com/superagent-ai/autobrin-flue) at a branch/SHA (or uses a local path), runs `flue run engagement` |
| `command` | Generic external CLI; add your own agent via config without naming it in repo source |

Example: [`config/contenders.example.jsonc`](config/contenders.example.jsonc)

`AUTOBRIN_FLUE_REF` defaults to `staging` when an autobrin contender omits `ref`. benchpress's own default branch is `main`; that is independent of which autobrin-flue branch you pin.

## Benchmarks

Registered in [`src/benchmarks/registry.ts`](src/benchmarks/registry.ts):

| ID | Lane | Status | Blocked on (autobrin-flue capability) |
| --- | --- | --- | --- |
| `repo-cve-smoke` | dev-smoke | **Runnable** | `repo` modality only — for harness/version testing, not scientific reporting |
| `cve-bench` | scientific | Stub | `webapp` modality + cross-cutting computer-use confirmation |
| `cybergym` | scientific | Stub | PoC-generation skill + differential patched oracle |
| `bountybench` | scientific | Stub | `webapp` + computer-use (exploit) / detect-only mode (detect) |
| `owasp` | scientific | Stub | detect-only mode + CWE-label Youden scoring |

Scientific benchmarks stay stubbed until the corresponding capabilities land in autobrin-flue. CVE-Bench vendor wiring (`vendor.lock.json` + pinned clone setup) is in place for when the adapter is implemented.

### Dev smoke: `repo-cve-smoke`

Small repo-modality lane scored by **fix-commit overlap** (external oracle, not AutoBrin self-verdict). Pin vulnerable/fix SHAs in [`src/benchmarks/repo-cve-smoke/tasks.jsonc`](src/benchmarks/repo-cve-smoke/tasks.jsonc) before relying on results.

## CLI

```bash
bench list
bench run <benchmark> --contender <id> --model <model-id> [--flue-ref staging] [--task <id>]
bench matrix --config config/matrix.example.jsonc
bench daytona run --ref staging --image <cu-image> --vision-model <model> --payload '<json>' [--snapshot <name>] [--keep-sandbox]
bench daytona doctor [--image <cu-image>] [--snapshot <name>] [--keep-sandbox]
```

### Daytona launcher (`bench daytona`)

Standalone provisioning for autobrin-flue engagements **inside** a Daytona sandbox (topology A: agent-in-sandbox), mirroring the app repo's HTTP/SSE run flow:

1. `daytona.create` from a computer-use-enabled `--image` or `--snapshot`
2. Clone/build autobrin-flue at `--ref` (`staging` or `main` branch pins only)
3. Ensure computer-use assets and inject env (`AUTOBRIN_COMPUTER_USE=daytona`, `CUA_SCREENSHOT_VISION_MODEL`, provider keys)
4. Start `dist/server.mjs` in the sandbox and POST `/workflows/engagement` over SSE
5. Stream events to the caller and tear down the sandbox (unless `--keep-sandbox`)

`bench daytona doctor` creates a sandbox and verifies `cua-driver status` plus `http://127.0.0.1:2280/computeruse/status`.

#### Repo-modality smoke test

Requires `DAYTONA_API_KEY`, a computer-use image, and provider keys in your operator env file:

```bash
dotenvx run -f ~/.config/secrets/global.env -- npm run bench -- daytona run \
  --ref staging \
  --image <daytona-computer-use-image-or-snapshot> \
  --vision-model kimi-k2.6 \
  --payload '{"modality":"repo","repo":"https://github.com/<owner>/<repo>.git","sha":"<vulnerable-sha>","contributors":3,"model":"kimi-azure/kimi-k2.6"}'
```

Expect: sandbox created → autobrin-flue bootstrapped → engagement runs with computer-use env active → SSE streamed → sandbox deleted. No dependency on the app repo.

Webapp payloads are wired (`modality: "webapp"`, `target.url`) but end-to-end smoke requires autobrin-flue#157/#158.

## Output (gitignored)

- `runs/` — matrix metadata
- `results/` — scorecards and contender logs
- `engagements/` — autobrin engagement workspaces
- `.cache/` — cloned autobrin-flue checkouts and benchmark vendors

## Secrets

Use your operator env file (never commit repo `.env` files):

```bash
dotenvx run -f ~/.config/secrets/global.env -- npm run bench -- matrix --config config/matrix.example.jsonc
```

Agent keys (`AZURE_OPENAI_*`, etc.) pass through to autobrin-flue engagements.

## Relationship to autobrin-flue

benchpress **consumes** autobrin-flue at runtime (branch pin via `AUTOBRIN_FLUE_REF` / contender `ref`). autobrin-flue is not modified and does not reference benchpress. Capabilities (modalities, computer-use, detect-only, etc.) land in autobrin-flue via separate PRs; adapters here are filled in once those exist.
