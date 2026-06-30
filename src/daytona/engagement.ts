import type { Sandbox } from '@daytona/sdk';
import {
  AUTOBRIN_FLUE_DIR,
  BENCHPRESS_ROOT,
  LOGS_DIR,
  PAYLOAD_PATH,
  RESULT_PATH,
} from './constants.js';
import { engagementResultPath, type EngagementPayload } from './payload.js';
import { executeChecked } from './sandbox-exec.js';
import { shellQuote, writeFileCommand } from './shell.js';

export type EngagementRunResult = {
  exitCode: number;
  streamLogPath: string;
  resultPath: string;
  resultJson?: Record<string, unknown>;
};

export type EngagementRunScriptOptions = {
  /**
   * Maximum seconds to wait for the engagement to reach a terminal state
   * after the workflow run is admitted, before giving up. Kept comfortably
   * below the 3600s Daytona session-command timeout in `runEngagementViaHttp`
   * so the script itself reports a clear timeout instead of being killed.
   */
  maxWaitSeconds?: number;
  /** Seconds to sleep between completion-poll attempts. */
  pollIntervalSeconds?: number;
  /**
   * Absolute path where AutoBrin writes its `result.json` checkpoint for
   * this engagement. Defaults to `RESULT_PATH` (under `BENCHPRESS_ROOT`);
   * callers should pass `engagementResultPath(payload)` instead whenever the
   * payload's `workspaceRoot` may differ from `BENCHPRESS_ROOT`.
   */
  resultPath?: string;
  /**
   * Absolute path the script reads the engagement payload JSON from before
   * admitting the run. Defaults to `PAYLOAD_PATH`; overridable mainly so
   * tests can exercise the generated script without `BENCHPRESS_ROOT`
   * existing on disk.
   */
  payloadPath?: string;
};

const DEFAULT_MAX_WAIT_SECONDS = 3300;
const DEFAULT_POLL_INTERVAL_SECONDS = 3;

export async function writeEngagementPayload(sandbox: Sandbox, payload: EngagementPayload): Promise<void> {
  await executeChecked(sandbox, writeFileCommand(PAYLOAD_PATH, JSON.stringify(payload)), '/', 30);
}

export function buildEngagementRunScript(options: EngagementRunScriptOptions = {}): string {
  const maxWaitSeconds = options.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS;
  const pollIntervalSeconds = options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const resultPath = options.resultPath ?? RESULT_PATH;
  const payloadPath = options.payloadPath ?? PAYLOAD_PATH;

  return [
    '#!/bin/bash',
    'set -euo pipefail',
    `ROOT=${shellQuote(BENCHPRESS_ROOT)}`,
    `FLUE_ROOT=${shellQuote(AUTOBRIN_FLUE_DIR)}`,
    `PAYLOAD=${shellQuote(payloadPath)}`,
    `STREAM_LOG=${shellQuote(`${LOGS_DIR}/autobrin-flue.stream.jsonl`)}`,
    `SERVER_LOG=${shellQuote(`${LOGS_DIR}/autobrin-flue-server.log`)}`,
    `SERVER_ERR=${shellQuote(`${LOGS_DIR}/autobrin-flue-server.err`)}`,
    '',
    'find_free_port() {',
    '  python3 - <<\'PY\'',
    'import socket',
    'with socket.socket() as sock:',
    '    sock.bind(("127.0.0.1", 0))',
    '    print(sock.getsockname()[1])',
    'PY',
    '}',
    '',
    'FLUE_PORT="$(find_free_port)"',
    'export FLUE_PORT',
    'cd "$FLUE_ROOT"',
    'SERVER_ENTRY="$FLUE_ROOT/dist/server.mjs"',
    'if [ ! -f "$SERVER_ENTRY" ]; then',
    '  SERVER_ENTRY="$FLUE_ROOT/.flue/dist/server.mjs"',
    'fi',
    'if [ ! -f "$SERVER_ENTRY" ]; then',
    '  echo "AutoBrin Flue server entrypoint not found" >&2',
    '  exit 1',
    'fi',
    'PORT="$FLUE_PORT" FLUE_MODE=local node "$SERVER_ENTRY" >"$SERVER_LOG" 2>"$SERVER_ERR" &',
    'FLUE_SERVER_PID="$!"',
    'trap \'kill "$FLUE_SERVER_PID" 2>/dev/null || true\' EXIT',
    '',
    'python3 - <<\'PY\'',
    'import os',
    'import socket',
    'import time',
    '',
    'deadline = time.time() + 15',
    'port = int(os.environ["FLUE_PORT"])',
    'while time.time() < deadline:',
    '    try:',
    '        with socket.create_connection(("127.0.0.1", port), timeout=1):',
    '            raise SystemExit(0)',
    '    except OSError:',
    '        time.sleep(0.25)',
    'raise SystemExit("AutoBrin Flue server did not become reachable.")',
    'PY',
    '',
    // A stale checkpoint from a previous run in the same workspace must not be
    // mistaken for this run's completion signal (see the result-checkpoint
    // poll below).
    `rm -f ${shellQuote(resultPath)}`,
    '',
    'python3 - <<\'PY\' | tee "$STREAM_LOG"',
    'import json',
    'import os',
    'import sys',
    'import time',
    'import urllib.error',
    'import urllib.request',
    '',
    `PAYLOAD_PATH = ${JSON.stringify(payloadPath)}`,
    `RESULT_PATH = ${JSON.stringify(resultPath)}`,
    `MAX_WAIT_SECONDS = ${maxWaitSeconds}`,
    `POLL_INTERVAL_SECONDS = ${pollIntervalSeconds}`,
    'base_url = f"http://127.0.0.1:{os.environ[\'FLUE_PORT\']}"',
    '',
    '',
    'def emit(record):',
    '    sys.stdout.write(json.dumps(record) + "\\n")',
    '    sys.stdout.flush()',
    '',
    '',
    'def read_result_status():',
    '    try:',
    '        with open(RESULT_PATH, encoding="utf-8") as result_file:',
    '            data = json.load(result_file)',
    '    except (OSError, ValueError):',
    '        return None',
    '    if not isinstance(data, dict):',
    '        return None',
    '    status = data.get("status")',
    '    if status not in ("ok", "error"):',
    '        return None',
    '    # AutoBrin reserves stopReason "usage checkpoint" exclusively for its',
    '    # periodic mid-run progress writes (status "ok" written long before',
    '    # the engagement is actually done); every genuine completion path',
    '    # uses a different, descriptive stopReason. Treat it as "not yet',
    '    # decided" so this fallback can never mistake a mid-run checkpoint',
    '    # for the real final write (see superagent-ai/benchpress#8).',
    '    if status == "ok" and data.get("stopReason") == "usage checkpoint":',
    '        return None',
    '    return status',
    '',
    '',
    '# Step 1: admit the workflow run. Flue\'s POST /workflows/:name contract',
    '# returns a 202 admission receipt ({"runId": ...}) as soon as the run is',
    '# scheduled -- it does not block until the engagement finishes, and it is',
    '# never itself a live event stream regardless of the Accept header. See',
    '# https://flueframework.com/docs/api/workflow-api/#http-exports.',
    'payload_bytes = open(PAYLOAD_PATH, "rb").read()',
    'admit_request = urllib.request.Request(',
    '    f"{base_url}/workflows/engagement",',
    '    data=payload_bytes,',
    '    headers={"Content-Type": "application/json"},',
    '    method="POST",',
    ')',
    'try:',
    '    with urllib.request.urlopen(admit_request, timeout=30) as response:',
    '        admission = json.loads(response.read() or b"{}")',
    'except Exception as error:',
    '    emit({"type": "benchpress_admission_failed", "error": str(error)})',
    '    sys.exit(1)',
    '',
    'run_id = admission.get("runId") if isinstance(admission, dict) else None',
    'emit({"type": "benchpress_admitted", "runId": run_id})',
    'if not run_id:',
    '    emit({"type": "benchpress_admission_failed", "error": "admission response did not include a runId"})',
    '    sys.exit(1)',
    '',
    '',
    '# Step 2: wait for the engagement to actually finish. Admission does not',
    '# wait for completion, so the only way to know the run is done is to',
    '# either observe its Durable Streams run-event feed (GET /runs/:runId --',
    '# requires the workflow to export a Flue `runs` HTTP handler) or watch for',
    '# the result checkpoint AutoBrin writes to disk. The live run-event feed',
    '# is the primary, authoritative signal; the on-disk checkpoint is only a',
    '# fallback for once that feed itself can no longer tell us anything, and a',
    '# clear timeout replaces the previous silent-success behavior if neither',
    '# ever signals completion.',
    'run_events_available = True',
    'offset = "-1"',
    'run_is_error = None',
    'deadline = time.time() + MAX_WAIT_SECONDS',
    'while True:',
    '    if run_events_available:',
    '        try:',
    '            events_request = urllib.request.Request(f"{base_url}/runs/{run_id}?offset={offset}")',
    '            with urllib.request.urlopen(events_request, timeout=35) as response:',
    '                events = json.loads(response.read() or b"[]")',
    '                offset = response.headers.get("Stream-Next-Offset", offset)',
    '                stream_closed = response.headers.get("Stream-Closed") == "true"',
    '            for event in events:',
    '                emit(event)',
    '                if isinstance(event, dict) and event.get("type") == "run_end":',
    '                    run_is_error = bool(event.get("isError"))',
    '            if stream_closed:',
    '                # No further events will ever arrive on this stream. Stop',
    '                # polling it and fall through to the result.json checkpoint',
    '                # below in case a run_end event was somehow never observed.',
    '                run_events_available = False',
    '        except urllib.error.HTTPError as error:',
    '            if error.code == 404:',
    '                run_events_available = False',
    '                emit({',
    '                    "type": "benchpress_run_events_unavailable",',
    '                    "detail": (',
    '                        "GET /runs/:runId returned 404; the engagement workflow does not "',
    '                        "export a Flue `runs` HTTP handler yet. Falling back to result.json "',
    '                        "checkpoint polling for completion."',
    '                    ),',
    '                })',
    '            else:',
    '                emit({"type": "benchpress_run_events_error", "status": error.code})',
    '        except (urllib.error.URLError, OSError) as error:',
    '            emit({"type": "benchpress_run_events_error", "error": str(error)})',
    '',
    '    # Only fall back to the on-disk checkpoint once the live stream',
    '    # itself can no longer tell us anything -- closed, or 404/unavailable',
    '    # because the workflow does not export a Flue `runs` handler. Reading',
    '    # the checkpoint while the stream is still open and actively',
    '    # delivering events would let AutoBrin\'s periodic mid-run "usage',
    '    # checkpoint" writes (status "ok" long before the engagement is',
    '    # actually done) get mistaken for completion and kill a still-running',
    '    # engagement (see superagent-ai/benchpress#8).',
    '    if not run_events_available and run_is_error is None:',
    '        result_status = read_result_status()',
    '        if result_status is not None:',
    '            run_is_error = result_status == "error"',
    '',
    '    if run_is_error is not None:',
    '        break',
    '',
    '    if time.time() >= deadline:',
    '        emit({"type": "benchpress_engagement_timeout", "runId": run_id, "waitedSeconds": MAX_WAIT_SECONDS})',
    '        break',
    '',
    '    time.sleep(POLL_INTERVAL_SECONDS)',
    '',
    'if run_is_error is None:',
    '    emit({"type": "benchpress_engagement_incomplete", "runId": run_id})',
    '    sys.exit(1)',
    'sys.exit(1 if run_is_error else 0)',
    'PY',
    '',
    'exit_code=${PIPESTATUS[0]}',
    'python3 - <<\'PY\' || true',
    'import os',
    'import urllib.request',
    '',
    'port = os.environ.get("FLUE_PORT")',
    'if port:',
    '    request = urllib.request.Request(',
    '        f"http://127.0.0.1:{port}/__autobrin/observability/shutdown",',
    '        data=b"",',
    '        method="POST",',
    '    )',
    '    urllib.request.urlopen(request, timeout=10).close()',
    'PY',
    'kill "$FLUE_SERVER_PID" 2>/dev/null || true',
    'wait "$FLUE_SERVER_PID" 2>/dev/null || true',
    'trap - EXIT',
    'exit "$exit_code"',
  ].join('\n');
}

export async function runEngagementViaHttp(
  sandbox: Sandbox,
  payload: EngagementPayload,
  onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  scriptOptions?: EngagementRunScriptOptions,
): Promise<EngagementRunResult> {
  await writeEngagementPayload(sandbox, payload);

  // AutoBrin writes result.json under the payload's own workspaceRoot, which
  // callers may set away from BENCHPRESS_ROOT -- the wait loop and the final
  // read below must agree on that same, payload-derived location.
  const resultPath = scriptOptions?.resultPath ?? engagementResultPath(payload);
  const effectiveScriptOptions: EngagementRunScriptOptions = { ...scriptOptions, resultPath };

  const scriptPath = `${BENCHPRESS_ROOT}/bin/run-engagement`;
  await executeChecked(
    sandbox,
    [
      `mkdir -p ${shellQuote(`${BENCHPRESS_ROOT}/bin`)}`,
      writeFileCommand(scriptPath, buildEngagementRunScript(effectiveScriptOptions)),
      `chmod 755 ${shellQuote(scriptPath)}`,
    ].join('\n'),
    '/',
    30,
  );

  const sessionId = `benchpress-engagement-${Date.now()}`;
  await sandbox.process.createSession(sessionId);

  // The session-command timeout is the hard outer bound on this sandboxed
  // run; it must stay comfortably above the script's own internal
  // MAX_WAIT_SECONDS so the script can report a clean timeout diagnostic
  // instead of being killed mid-poll.
  const command = await sandbox.process.executeSessionCommand(
    sessionId,
    {
      command: scriptPath,
      runAsync: true,
    },
    3600,
  );

  if (!command.cmdId) {
    throw new Error('Daytona session did not return a command id for engagement run');
  }

  if (onChunk) {
    await sandbox.process.getSessionCommandLogs(sessionId, command.cmdId, (chunk) => onChunk(chunk, 'stdout'), (chunk) =>
      onChunk(chunk, 'stderr'),
    );
  } else {
    await sandbox.process.getSessionCommandLogs(sessionId, command.cmdId);
  }

  const finalCommand = await sandbox.process.getSessionCommand(sessionId, command.cmdId);
  const exitCode = finalCommand.exitCode ?? 1;

  let resultJson: Record<string, unknown> | undefined;
  const resultRead = await sandbox.process.executeCommand(`cat ${shellQuote(resultPath)}`, '/', undefined, 15);
  if (resultRead.exitCode === 0 && resultRead.result.trim()) {
    try {
      resultJson = JSON.parse(resultRead.result) as Record<string, unknown>;
    } catch {
      resultJson = undefined;
    }
  }

  await sandbox.process.deleteSession(sessionId).catch(() => undefined);

  return {
    exitCode,
    streamLogPath: `${LOGS_DIR}/autobrin-flue.stream.jsonl`,
    resultPath,
    resultJson,
  };
}
