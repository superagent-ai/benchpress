import type { Sandbox } from '@daytona/sdk';
import {
  AUTOBRIN_FLUE_DIR,
  BENCHPRESS_ROOT,
  LOGS_DIR,
  PAYLOAD_PATH,
  RESULT_PATH,
} from './constants.js';
import type { EngagementPayload } from './payload.js';
import { executeChecked } from './sandbox-exec.js';
import { shellQuote, writeFileCommand } from './shell.js';

export type EngagementRunResult = {
  exitCode: number;
  streamLogPath: string;
  resultPath: string;
  resultJson?: Record<string, unknown>;
};

export async function writeEngagementPayload(sandbox: Sandbox, payload: EngagementPayload): Promise<void> {
  await executeChecked(sandbox, writeFileCommand(PAYLOAD_PATH, JSON.stringify(payload)), '/', 30);
}

export function buildEngagementRunScript(): string {
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    `ROOT=${shellQuote(BENCHPRESS_ROOT)}`,
    `FLUE_ROOT=${shellQuote(AUTOBRIN_FLUE_DIR)}`,
    `PAYLOAD=${shellQuote(PAYLOAD_PATH)}`,
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
    'python3 - <<\'PY\' | tee "$STREAM_LOG"',
    'import os',
    'import sys',
    'import urllib.request',
    '',
    `payload = open(${JSON.stringify(PAYLOAD_PATH)}, encoding="utf-8").read()`,
    'url = f"http://127.0.0.1:{os.environ[\'FLUE_PORT\']}/workflows/engagement"',
    'request = urllib.request.Request(',
    '    url,',
    '    data=payload.encode("utf-8"),',
    '    headers={"Content-Type": "application/json", "Accept": "text/event-stream"},',
    '    method="POST",',
    ')',
    'with urllib.request.urlopen(request, timeout=None) as response:',
    '    for chunk in response:',
    '        sys.stdout.buffer.write(chunk)',
    '        sys.stdout.buffer.flush()',
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
): Promise<EngagementRunResult> {
  await writeEngagementPayload(sandbox, payload);

  const scriptPath = `${BENCHPRESS_ROOT}/bin/run-engagement`;
  await executeChecked(
    sandbox,
    [
      `mkdir -p ${shellQuote(`${BENCHPRESS_ROOT}/bin`)}`,
      writeFileCommand(scriptPath, buildEngagementRunScript()),
      `chmod 755 ${shellQuote(scriptPath)}`,
    ].join('\n'),
    '/',
    30,
  );

  const sessionId = `benchpress-engagement-${Date.now()}`;
  await sandbox.process.createSession(sessionId);

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
  const resultRead = await sandbox.process.executeCommand(`cat ${shellQuote(RESULT_PATH)}`, '/', undefined, 15);
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
    resultPath: RESULT_PATH,
    resultJson,
  };
}
