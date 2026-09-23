/**
 * Terminal + command recording. The command is executed for real through
 * commandRunner; the returned stdout/stderr/exit code are the process's own.
 */
import { query } from '../db/pool.ts';
import { runCommand } from './commandRunner.ts';
import { WorkspaceService } from './workspace.ts';
import { logEvent } from './eventBus.ts';
import { config } from '../config/index.ts';

export interface TerminalResult {
  id: string;
  command: string;
  backend: 'docker' | 'host';
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  status: 'succeeded' | 'failed' | 'timeout';
}

export async function runTerminalCommand(input: {
  projectId: string;
  ownerId: string;
  command: string;
  agentRunId?: string | null;
  source?: 'terminal' | 'agent' | 'build' | 'test';
  timeoutMs?: number;
}): Promise<TerminalResult> {
  const ws = new WorkspaceService(input.projectId);
  await ws.ensure();

  logEvent(input.projectId, 'command_log', 'info', `$ ${input.command}`, { source: input.source ?? 'terminal' });

  const result = await runCommand({
    cwd: ws.root,
    command: input.command,
    timeoutMs: input.timeoutMs ?? config.commandTimeoutMs,
    onChunk: (stream, text) => {
      logEvent(input.projectId, 'command_log', stream === 'stderr' ? 'warn' : 'info', text, {
        source: input.source ?? 'terminal',
        stream,
      });
    },
  });

  const inserted = await query<{ id: string }>(
    `INSERT INTO commands (project_id, agent_run_id, owner_id, source, command, cwd, stdout, stderr, exit_code, duration_ms, truncated, timed_out, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      input.projectId,
      input.agentRunId ?? null,
      input.ownerId,
      input.source ?? 'terminal',
      input.command.slice(0, 8000),
      result.cwd,
      result.stdout,
      result.stderr,
      result.exitCode,
      result.durationMs,
      result.truncated,
      result.timedOut,
      result.status,
    ],
  );

  logEvent(input.projectId, 'command_log', result.status === 'succeeded' ? 'info' : 'error', `exit code: ${result.exitCode ?? 'null'}`, {
    source: input.source ?? 'terminal',
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    status: result.status,
  });

  return {
    id: inserted.rows[0].id,
    command: result.command,
    backend: result.backend,
    cwd: result.cwd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated,
    timedOut: result.timedOut,
    status: result.status,
  };
}

export async function listCommands(projectId: string, limit = 25): Promise<
  Array<{ id: string; command: string; exit_code: number | null; status: string; created_at: Date; duration_ms: number | null }>
> {
  const res = await query<{ id: string; command: string; exit_code: number | null; status: string; created_at: Date; duration_ms: number | null }>(
    `SELECT id, command, exit_code, status, created_at, duration_ms FROM commands
     WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [projectId, limit],
  );
  return res.rows;
}
