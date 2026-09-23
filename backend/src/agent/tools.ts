/**
 * Agent tools. Each tool performs a real operation against the project
 * workspace and returns real output. Tools never invent results: failures are
 * returned as { ok: false, error }.
 */
import { z } from 'zod';
import { WorkspaceService } from '../services/workspace.ts';
import { runCommand } from '../services/commandRunner.ts';
import { runTests } from '../services/tests.ts';
import { runBuild } from '../services/build.ts';
import { inspectApk } from '../services/apkInspect.ts';
import { logger } from '../lib/logger.ts';
import { config } from '../config/index.ts';
import type { AgentPhase } from '../services/eventBus.ts';

export interface ToolContext {
  projectId: string;
  ownerId: string;
  agentRunId: string | null;
  onPhase: (phase: AgentPhase, message: string) => void;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  output: unknown;
  error?: string;
}

const Schemas = {
  list_files: z.object({ dir: z.string().default('.'), depth: z.number().int().min(1).max(6).default(3) }),
  read_file: z.object({ path: z.string() }),
  create_file: z.object({ path: z.string(), content: z.string().default('') }),
  edit_file: z.object({
    path: z.string(),
    find: z.string().optional(),
    replace: z.string().optional(),
    content: z.string().optional(),
  }),
  delete_file: z.object({ path: z.string() }),
  search_code: z.object({ query: z.string(), regex: z.boolean().default(false), maxResults: z.number().int().min(1).max(500).default(100) }),
  run_command: z.object({ command: z.string(), timeoutMs: z.number().int().min(1000).max(1800000).optional() }),
  run_tests: z.object({}),
  build_project: z.object({}),
  build_android: z.object({ target: z.enum(['debug', 'release']).default('debug') }),
  inspect_build_error: z.object({ log: z.string().optional() }),
  inspect_apk: z.object({}),
  git_status: z.object({}),
  git_diff: z.object({ path: z.string().optional() }),
} as const;

export type ToolName = keyof typeof Schemas;

export const TOOL_NAMES = Object.keys(Schemas) as ToolName[];

/** Tools that mutate the workspace or start long jobs require explicit intent. */
export const MUTATING_TOOLS: ToolName[] = [
  'create_file', 'edit_file', 'delete_file', 'run_command', 'build_project', 'build_android',
];

export async function executeTool(name: ToolName, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const schema = Schemas[name];
  if (!schema) return { ok: false, output: null, error: `unknown tool: ${name}` };

  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, output: null, error: `invalid tool arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  }

  const ws = new WorkspaceService(ctx.projectId);
  await ws.ensure();
  const input = parsed.data;

  try {
    switch (name) {
      case 'list_files': {
        ctx.onPhase('reading', 'listing project files');
        const files = await ws.list((input as z.infer<typeof Schemas.list_files>).dir, (input as z.infer<typeof Schemas.list_files>).depth);
        return {
          ok: true,
          output: {
            count: files.length,
            files: files.slice(0, 500).map((f) => ({ path: f.path, type: f.type, size: f.size })),
          },
        };
      }

      case 'read_file': {
        ctx.onPhase('reading', 'reading files');
        const { path: filePath } = input as z.infer<typeof Schemas.read_file>;
        const file = await ws.read(filePath);
        return { ok: true, output: { path: file.path, size: file.size, content: file.content.slice(0, 60000) } };
      }

      case 'create_file': {
        ctx.onPhase('editing', 'creating file');
        const { path: filePath, content } = input as z.infer<typeof Schemas.create_file>;
        const written = await ws.write(filePath, content);
        return { ok: true, output: { path: written.path, size: written.size } };
      }

      case 'edit_file': {
        ctx.onPhase('editing', 'editing file');
        const { path: filePath, find, replace, content } = input as z.infer<typeof Schemas.edit_file>;
        if (content !== undefined) {
          const written = await ws.write(filePath, content);
          return { ok: true, output: { path: written.path, mode: 'overwrite', size: written.size } };
        }
        if (find === undefined || replace === undefined) {
          return { ok: false, output: null, error: 'edit_file requires either `content`, or both `find` and `replace`' };
        }
        const existing = await ws.read(filePath);
        const occurrences = existing.content.split(find).length - 1;
        if (occurrences === 0) {
          return { ok: false, output: null, error: `find string not present in ${filePath}` };
        }
        if (occurrences > 1) {
          return { ok: false, output: null, error: `find string is ambiguous (${occurrences} occurrences) in ${filePath}` };
        }
        const updated = existing.content.replace(find, replace);
        const written = await ws.write(filePath, updated);
        return { ok: true, output: { path: written.path, mode: 'replace', size: written.size } };
      }

      case 'delete_file': {
        ctx.onPhase('editing', 'deleting file');
        const { path: filePath } = input as z.infer<typeof Schemas.delete_file>;
        const removed = await ws.remove(filePath);
        return { ok: true, output: removed };
      }

      case 'search_code': {
        ctx.onPhase('reading', 'searching code');
        const { query, regex, maxResults } = input as z.infer<typeof Schemas.search_code>;
        const matches = await ws.search(query, { regex, maxResults });
        return { ok: true, output: { count: matches.length, matches } };
      }

      case 'run_command': {
        ctx.onPhase('running', 'running command');
        const { command, timeoutMs } = input as z.infer<typeof Schemas.run_command>;
        const result = await runCommand({
          cwd: ws.root,
          command,
          timeoutMs: timeoutMs ?? config.commandTimeoutMs,
        });
        return {
          ok: result.status === 'succeeded',
          output: {
            command: result.command,
            backend: result.backend,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            stdout: result.stdout.slice(-20000),
            stderr: result.stderr.slice(-20000),
          },
          error: result.status === 'succeeded' ? undefined : `command exited with ${result.exitCode ?? 'null'}`,
        };
      }

      case 'run_tests': {
        ctx.onPhase('testing', 'running tests');
        const result = await runTests({ projectId: ctx.projectId, ownerId: ctx.ownerId, agentRunId: ctx.agentRunId });
        return {
          ok: result.status === 'passed',
          output: {
            status: result.status, framework: result.framework, command: result.command,
            passed: result.passed, failed: result.failed, skipped: result.skipped,
            durationMs: result.durationMs, log: result.log.slice(-12000), error: result.error,
          },
          error: result.status === 'passed' ? undefined : (result.error ?? result.status),
        };
      }

      case 'build_project':
      case 'build_android': {
        ctx.onPhase('building', 'building project');
        const target = name === 'build_android'
          ? (input as z.infer<typeof Schemas.build_android>).target
          : 'debug';
        const result = await runBuild({
          projectId: ctx.projectId,
          ownerId: ctx.ownerId,
          agentRunId: ctx.agentRunId,
          target,
          runSecurityScan: true,
        });
        return {
          ok: result.status === 'succeeded',
          output: {
            buildId: result.id, kind: result.kind, target: result.target, status: result.status,
            command: result.command, exitCode: result.exitCode, durationMs: result.durationMs,
            apk: result.apk ? { relPath: result.apk.relPath, sizeBytes: result.apk.sizeBytes, sha256: result.apk.sha256 } : null,
            inspection: result.inspection,
            security: result.security ? { status: result.security.status, findings: result.security.findings } : null,
            logTail: result.log.slice(-12000),
            error: result.error,
          },
          error: result.status === 'succeeded' ? undefined : (result.error ?? result.status),
        };
      }

      case 'inspect_build_error': {
        ctx.onPhase('inspecting', 'inspecting build error');
        const explicitLog = (input as z.infer<typeof Schemas.inspect_build_error>).log;
        let log = explicitLog ?? '';
        if (!log) {
          // Use the most recent real build log from the database.
          const { query } = await import('../db/pool.ts');
          const res = await query<{ log: string; command: string; exit_code: number | null }>(
            `SELECT log, command, exit_code FROM builds WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [ctx.projectId],
          );
          log = res.rows[0]?.log ?? '';
        }
        const analysis = analyzeBuildError(log);
        return { ok: analysis.errors.length > 0, output: analysis, error: analysis.errors.length === 0 ? 'no recognizable error pattern found in the log' : undefined };
      }

      case 'inspect_apk': {
        ctx.onPhase('inspecting', 'inspecting APK');
        const { latestApk } = await import('../services/build.ts');
        const apk = await latestApk(ctx.projectId);
        if (!apk) return { ok: false, output: null, error: 'no APK has been generated for this project' };
        const inspection = await inspectApk(apk.path);
        return { ok: inspection.exists, output: inspection };
      }

      case 'git_status': {
        const result = await runCommand({ cwd: ws.root, command: 'git status --porcelain=v1 --branch', timeoutMs: 30000 });
        return { ok: result.status === 'succeeded', output: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr } };
      }

      case 'git_diff': {
        const { path: diffPath } = input as z.infer<typeof Schemas.git_diff>;
        const cmd = diffPath ? `git --no-pager diff -- ${JSON.stringify(diffPath)}` : 'git --no-pager diff';
        const result = await runCommand({ cwd: ws.root, command: cmd, timeoutMs: 60000 });
        return { ok: result.status === 'succeeded', output: { exitCode: result.exitCode, stdout: result.stdout.slice(-20000), stderr: result.stderr } };
      }

      default:
        return { ok: false, output: null, error: `unhandled tool: ${String(name)}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('tool failed', { tool: name, error: message });
    return { ok: false, output: null, error: message };
  }
}

export interface BuildErrorAnalysis {
  errors: Array<{ kind: string; message: string; file: string | null; line: number | null }>;
  summary: string;
}

/**
 * Parses a real compiler/build log for common failure patterns and extracts the
 * file/line references that are actually present in the output.
 */
export function analyzeBuildError(log: string): BuildErrorAnalysis {
  const errors: BuildErrorAnalysis['errors'] = [];
  const lines = log.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Kotlin: e: file:///path/File.kt:12:34 message
    const kotlin = /^e:\s*(?:file:\/\/)?([^:]+):(\d+):(\d+)\s*(.*)$/.exec(line);
    if (kotlin) {
      errors.push({ kind: 'kotlin', message: kotlin[4].trim(), file: kotlin[1], line: Number(kotlin[2]) });
      continue;
    }

    // Java/javac: /path/File.java:12: error: message
    const javac = /^([^\s].*\.java):(\d+):\s*error:\s*(.*)$/.exec(line);
    if (javac) {
      errors.push({ kind: 'java', message: javac[3].trim(), file: javac[1], line: Number(javac[2]) });
      continue;
    }

    // Gradle task failure line
    const task = /^Execution failed for task '([^']+)'/.exec(line);
    if (task) {
      errors.push({ kind: 'gradle-task', message: `task ${task[1]} failed`, file: null, line: null });
      continue;
    }

    // TypeScript: src/file.ts(12,34): error TS1234: message
    const tsc = /^(.+\.tsx?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.*)$/.exec(line);
    if (tsc) {
      errors.push({ kind: 'typescript', message: `${tsc[4]} ${tsc[5]}`.trim(), file: tsc[1], line: Number(tsc[2]) });
      continue;
    }

    const genericError = /^\s*(?:error|Error):\s+(.*)$/.exec(line);
    if (genericError && errors.length < 40) {
      errors.push({ kind: 'generic', message: genericError[1].trim(), file: null, line: null });
    }
  }

  // Missing symbol / unresolved reference detail lines are very actionable.
  const unresolved = [...log.matchAll(/Unresolved reference(?::|\s+)([^\s.]+)/g)].map((m) => m[1]);
  const summaryParts: string[] = [];
  if (errors.length) summaryParts.push(`${errors.length} error(s) parsed`);
  if (unresolved.length) summaryParts.push(`unresolved references: ${[...new Set(unresolved)].join(', ')}`);
  if (/Could not resolve|Could not find/i.test(log)) summaryParts.push('dependency resolution failure');
  if (/SDK location not found/i.test(log)) summaryParts.push('ANDROID_HOME/local.properties missing');
  if (/Unsupported class file major version/i.test(log)) summaryParts.push('JDK/Gradle version mismatch');
  if (/OutOfMemoryError/i.test(log)) summaryParts.push('build ran out of memory');

  return {
    errors: errors.slice(0, 40),
    summary: summaryParts.length ? summaryParts.join('; ') : 'no recognizable error pattern in the log',
  };
}
