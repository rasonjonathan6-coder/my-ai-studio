/**
 * Test runner. Detects the real test framework present in the project and runs
 * it. When no framework is configured the status is 'unavailable' - never a
 * fabricated pass.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/pool.ts';
import { runCommand, toolchainEnv } from './commandRunner.ts';
import { WorkspaceService } from './workspace.ts';
import { logEvent } from './eventBus.ts';
import { config } from '../config/index.ts';

export interface TestRunResult {
  id: string;
  framework: string;
  command: string | null;
  status: 'passed' | 'failed' | 'timeout' | 'unavailable';
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  log: string;
  error: string | null;
}

interface Detection {
  framework: string;
  command: string | null;
  reason?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function detectTestCommand(projectRoot: string): Promise<Detection> {
  const hasWrapper = await exists(path.join(projectRoot, 'gradlew'));
  const hasGradleSettings = (await exists(path.join(projectRoot, 'settings.gradle.kts'))) || (await exists(path.join(projectRoot, 'settings.gradle')));
  if (hasWrapper) return { framework: 'gradle', command: './gradlew test --console=plain --no-daemon' };
  if (hasGradleSettings) {
    return {
      framework: 'gradle',
      command: 'gradle test --console=plain --no-daemon',
      reason: 'gradle-wrapper.jar absent, using the system gradle binary',
    };
  }

  const pkgPath = path.join(projectRoot, 'package.json');
  if (await exists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) return { framework: 'node-package-script', command: 'npm test' };
      // A Node project with no test script gets the built-in runner when tests exist
      if (await exists(path.join(projectRoot, 'test')) || await exists(path.join(projectRoot, 'tests'))) {
        return { framework: 'node:test', command: 'node --test' };
      }
    } catch {
      return { framework: 'unknown', command: null, reason: 'package.json could not be parsed' };
    }
  }

  if (await exists(path.join(projectRoot, 'pytest.ini')) || await exists(path.join(projectRoot, 'pyproject.toml'))) {
    return { framework: 'pytest', command: 'python3 -m pytest -q' };
  }

  return { framework: 'none', command: null, reason: 'no supported test framework detected in this project' };
}

/**
 * Counts real JUnit XML results written by Gradle under build/test-results.
 * Gradle's console output is unreliable to parse; the XML report is not.
 */
export async function parseGradleXmlResults(projectRoot: string): Promise<{ passed: number; failed: number; skipped: number; files: string[] }> {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const files: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.name.startsWith('TEST-') && entry.name.endsWith('.xml')) {
        try {
          const xml = await fs.readFile(full, 'utf8');
          for (const tag of xml.match(/<testsuite\b[^>]*>/g) ?? []) {
            const tests = Number(/tests="(\d+)"/.exec(tag)?.[1] ?? 0);
            const failures = Number(/failures="(\d+)"/.exec(tag)?.[1] ?? 0);
            const errors = Number(/errors="(\d+)"/.exec(tag)?.[1] ?? 0);
            const skips = Number(/skipped="(\d+)"/.exec(tag)?.[1] ?? 0);
            passed += Math.max(tests - failures - errors - skips, 0);
            failed += failures + errors;
            skipped += skips;
          }
          files.push(path.relative(projectRoot, full).split(path.sep).join('/'));
        } catch {
          // An unreadable report must not silently become a pass.
        }
      }
    }
  }

  await walk(projectRoot, 0);
  return { passed, failed, skipped, files };
}

/** Parses framework-specific text output for pass/fail counts. */
export function parseCounts(framework: string, output: string): { passed: number; failed: number; skipped: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  if (framework === 'node:test' || framework === 'node-package-script') {
    passed = Number(/# pass (\d+)/.exec(output)?.[1] ?? 0);
    failed = Number(/# fail (\d+)/.exec(output)?.[1] ?? 0);
    skipped = Number(/# skipped (\d+)/.exec(output)?.[1] ?? 0);
  } else {
    const mochaPassing = /(\d+)\s+passing/.exec(output);
    const mochaFailing = /(\d+)\s+failing/.exec(output);
    if (mochaPassing) passed = Number(mochaPassing[1]);
    if (mochaFailing) failed = Number(mochaFailing[1]);
    if (!mochaPassing) {
      const passMatch = /(\d+)\s+passed/.exec(output);
      if (passMatch) passed = Number(passMatch[1]);
    }
    const failMatch = /(\d+)\s+failed/.exec(output);
    const skipMatch = /(\d+)\s+skipped/.exec(output);
    if (failMatch) failed = Number(failMatch[1]);
    if (skipMatch) skipped = Number(skipMatch[1]);
  }
  return { passed, failed, skipped };
}

export async function runTests(input: {
  projectId: string;
  ownerId: string;
  agentRunId?: string | null;
  commandOverride?: string;
}): Promise<TestRunResult> {
  const ws = new WorkspaceService(input.projectId);
  await ws.ensure();

  const detection = await detectTestCommand(ws.root);
  const command = input.commandOverride ?? detection.command;

  if (!command) {
    const inserted = await query<{ id: string }>(
      `INSERT INTO tests (project_id, agent_run_id, owner_id, framework, command, status, log, error, finished_at)
       VALUES ($1, $2, $3, $4, NULL, 'unavailable', '', $5, now()) RETURNING id`,
      [input.projectId, input.agentRunId ?? null, input.ownerId, detection.framework, detection.reason ?? 'no test command'],
    );
    logEvent(input.projectId, 'test_log', 'warn', `TEST STATUS: UNAVAILABLE - ${detection.reason ?? 'no test command detectable'}`);
    return {
      id: inserted.rows[0].id,
      framework: detection.framework,
      command: null,
      status: 'unavailable',
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
      log: '',
      error: detection.reason ?? 'no test command',
    };
  }

  logEvent(input.projectId, 'test_log', 'info', `running tests: ${command}`, { framework: detection.framework });
  const result = await runCommand({
    cwd: ws.root,
    command,
    timeoutMs: config.buildTimeoutMs,
    env: await toolchainEnv(),
    onChunk: (stream, text) => logEvent(input.projectId, 'test_log', stream === 'stderr' ? 'warn' : 'info', text),
  });

  const output = `${result.stdout}\n${result.stderr}`;

  // Gradle console output does not reliably report counts, so prefer the
  // machine-readable JUnit XML report it writes to build/test-results.
  let counts = parseCounts(detection.framework, output);
  let reportFiles: string[] = [];
  if (detection.framework === 'gradle') {
    const xml = await parseGradleXmlResults(ws.root);
    reportFiles = xml.files;
    if (xml.files.length > 0) {
      counts = { passed: xml.passed, failed: xml.failed, skipped: xml.skipped };
      logEvent(input.projectId, 'test_log', 'info',
        `JUnit XML reports: ${xml.files.length} file(s), ${xml.passed} passed, ${xml.failed} failed, ${xml.skipped} skipped`);
    } else {
      logEvent(input.projectId, 'test_log', 'warn',
        'no JUnit XML report found under build/test-results; counts unavailable from report');
    }
  }
  if (reportFiles.length > 0 && counts.passed + counts.failed === 0) {
    logEvent(input.projectId, 'test_log', 'warn', 'test reports exist but contain zero test cases');
  }

  const status: TestRunResult['status'] = result.timedOut
    ? 'timeout'
    : result.exitCode === 0
      ? 'passed'
      : 'failed';

  const inserted = await query<{ id: string }>(
    `INSERT INTO tests (project_id, agent_run_id, owner_id, framework, command, status, passed, failed, skipped, duration_ms, log, error, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now()) RETURNING id`,
    [
      input.projectId,
      input.agentRunId ?? null,
      input.ownerId,
      detection.framework,
      command,
      status,
      counts.passed,
      counts.failed,
      counts.skipped,
      result.durationMs,
      output.slice(0, 200000),
      result.exitCode === 0 ? null : (result.stderr.trim().split('\n').slice(-8).join('\n') || `exit code ${result.exitCode}`),
    ],
  );

  logEvent(input.projectId, 'test_log', status === 'passed' ? 'info' : 'error', `tests ${status.toUpperCase()}`, {
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    exitCode: result.exitCode,
  });

  return {
    id: inserted.rows[0].id,
    framework: detection.framework,
    command,
    status,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    durationMs: result.durationMs,
    log: output.slice(0, 200000),
    error: result.exitCode === 0 ? null : `exit code ${result.exitCode}`,
  };
}
