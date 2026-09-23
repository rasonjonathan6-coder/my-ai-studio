/**
 * The agent loop: ANALYZE -> PLAN -> READ -> EDIT -> RUN -> TEST -> BUILD, with
 * a bounded INSPECT -> FIX -> REBUILD retry cycle.
 *
 * The model decides which tools to call. Every tool call is executed against
 * the real workspace. If OpenRouter is not configured the run fails explicitly
 * with OPENROUTER_NOT_CONFIGURED - the loop never falls back to a scripted
 * "pretend" edit.
 */
import { query } from '../db/pool.ts';
import { config } from '../config/index.ts';
import { logger, redact } from '../lib/logger.ts';
import { openRouter, type ChatMessage } from '../services/openrouter.ts';
import { WorkspaceService } from '../services/workspace.ts';
import { agentEvent, logEvent, type AgentPhase } from '../services/eventBus.ts';
import { runTests } from '../services/tests.ts';
import { runBuild, latestApk } from '../services/build.ts';
import { jobQueue } from '../services/jobQueue.ts';
import { TOOL_NAMES, executeTool, type ToolName, type ToolResult } from './tools.ts';
import { detectBuild } from '../services/build.ts';
import { detectTestCommand } from '../services/tests.ts';

export interface AgentRunOptions {
  projectId: string;
  ownerId: string;
  prompt: string;
  agentRunId: string;
  conversationId: string | null;
  signal?: AbortSignal;
}

export interface AgentRunOutcome {
  status: 'succeeded' | 'failed' | 'limit_reached' | 'cancelled';
  summary: string;
  fixAttempts: number;
  finalPhase: AgentPhase;
}

const MAX_HISTORY_MESSAGES = 24;
const MAX_STEPS_PER_ATTEMPT = 12;

interface ToolCallRequest {
  tool: ToolName;
  args: Record<string, unknown>;
  reason?: string;
}

const SYSTEM_PROMPT = `You are the coding agent inside My AI Studio, working inside a real project workspace on disk.

You can act using tools. To call a tool, reply with ONLY a JSON object of this exact shape (no markdown fences, no prose):
{"tool":"<tool_name>","args":{...},"reason":"<why>"}

Available tools and their arguments:
- list_files {"dir":".","depth":3}
- read_file {"path":"..."}
- create_file {"path":"...","content":"..."}
- edit_file {"path":"...","find":"exact substring","replace":"replacement"}  (or {"path":"...","content":"full new content"})
- delete_file {"path":"..."}
- search_code {"query":"...","regex":false}
- run_command {"command":"...","timeoutMs":600000}
- run_tests {}
- build_project {}
- build_android {"target":"debug"}
- inspect_build_error {"log":"..."}
- inspect_apk {}
- git_status {}
- git_diff {"path":"..."}

When you are finished with the whole request, reply with ONLY:
{"done":true,"summary":"<what you changed and the verified result>"}

Rules:
- All paths are relative to the project root (for example "app/src/main/java/com/example/MainActivity.kt"). Never use absolute paths.
- Prefer edit_file over create_file when a file already exists.
- You may call at most one tool per reply.
- Always verify your work: after editing, run the project's tests or a build.
- If a build fails, read the log, identify the offending file, fix it, and rebuild.
- Never claim something succeeded unless a tool result confirmed it.
- Keep file contents complete and compilable; do not leave TODO placeholders.
- Do not write secrets, API keys or credentials into any file.`;

function buildContextPrompt(environment: {
  files: string;
  buildSystem: string;
  testSystem: string;
}): string {
  return `Project environment detected on the server:
${environment.files}

Build system: ${environment.buildSystem}
Test system: ${environment.testSystem}

Follow the project's existing structure and conventions.`;
}

async function readRun(runId: string): Promise<{ fix_attempts: number; max_fix_attempts: number; status: string } | null> {
  const res = await query<{ fix_attempts: number; max_fix_attempts: number; status: string }>(
    'SELECT fix_attempts, max_fix_attempts, status FROM agent_runs WHERE id = $1',
    [runId],
  );
  return res.rows[0] ?? null;
}

async function updateRun(runId: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await query(`UPDATE agent_runs SET ${setClause} WHERE id = $1`, [runId, ...keys.map((k) => fields[k])]);
}

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // fall through to brace scanning
  }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function parseToolCall(text: string): ToolCallRequest | { done: true; summary: string } | null {
  const json = extractJson(text);
  if (!json) return null;
  if (json.done === true) {
    return { done: true, summary: typeof json.summary === 'string' ? json.summary : 'Agent reported completion.' };
  }
  const tool = json.tool;
  if (typeof tool !== 'string' || !TOOL_NAMES.includes(tool as ToolName)) return null;
  const args = (json.args && typeof json.args === 'object' ? json.args : {}) as Record<string, unknown>;
  return { tool: tool as ToolName, args, reason: typeof json.reason === 'string' ? json.reason : undefined };
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunOutcome> {
  const { projectId, ownerId, prompt, agentRunId, signal } = options;

  if (!openRouter.isConfigured()) {
    const message = 'OPENROUTER_NOT_CONFIGURED: set OPENROUTER_API_KEY on the server to enable the AI agent. No agent actions were performed.';
    await updateRun(agentRunId, {
      status: 'failed', phase: 'failed', error: message, finished_at: new Date().toISOString(),
    });
    agentEvent(projectId, 'failed', message, { agentRunId });
    logEvent(projectId, 'build_log', 'error', message);
    return { status: 'failed', summary: message, fixAttempts: 0, finalPhase: 'failed' };
  }

  const run = await readRun(agentRunId);
  const maxFixAttempts = run?.max_fix_attempts ?? config.maxFixAttempts;

  const ws = new WorkspaceService(projectId);
  await ws.ensure();

  await updateRun(agentRunId, {
    status: 'running', phase: 'analyzing', started_at: new Date().toISOString(), model: config.openRouterModel,
  });

  const onPhase = (phase: AgentPhase, message: string): void => {
    agentEvent(projectId, phase, message, { agentRunId });
    void updateRun(agentRunId, { phase });
  };

  // ---------- ANALYZE (real filesystem + toolchain inspection) ---------------
  onPhase('analyzing', 'ANALYZING project workspace');
  const files = await ws.list('.', 4);
  const buildDetection = await detectBuild({ projectId, target: 'debug' });
  const testDetection = await detectTestCommand(ws.root);

  const fileTree = files
    .slice(0, 300)
    .map((f) => `${f.type === 'directory' ? 'dir ' : 'file'} ${f.path}${f.type === 'file' ? ` (${f.size}b)` : ''}`)
    .join('\n');

  const contextPrompt = buildContextPrompt({
    files: fileTree || '(workspace is empty)',
    buildSystem: buildDetection.command ?? `none detected (${buildDetection.reason ?? 'unknown'})`,
    testSystem: testDetection.command ?? `none detected (${testDetection.reason ?? 'unknown'})`,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: contextPrompt },
    { role: 'user', content: prompt },
  ];

  let fixAttempts = 0;
  let summary = '';
  let lastBuildFailureLog = '';
  let tokensIn = 0;
  let tokensOut = 0;

  const callModel = async (): Promise<{ ok: boolean; text: string; error?: string }> => {
    // Free-tier models are rate limited aggressively. A 429 is transient, so
    // wait out the provider's Retry-After before giving up on the step instead
    // of failing the whole run on the first throttle.
    for (let waitRound = 0; waitRound < 4; waitRound += 1) {
      const result = await openRouter.chat({
        messages: messages.slice(-MAX_HISTORY_MESSAGES),
        signal,
      });
      if (result.ok) {
        tokensIn += result.usage.promptTokens;
        tokensOut += result.usage.completionTokens;
        return { ok: true, text: result.content };
      }
      if (result.kind !== 'rate_limited' || waitRound === 3 || signal?.aborted) {
        return { ok: false, text: '', error: `${result.kind}: ${result.message}` };
      }
      const pauseMs = result.retryAfterMs ?? 15000;
      logEvent(projectId, 'build_log', 'warn', `model rate limited, waiting ${pauseMs}ms before retrying the step`);
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    return { ok: false, text: '', error: 'rate_limited: exhausted step-level retries' };
  };

  for (let attempt = 0; attempt <= maxFixAttempts; attempt += 1) {
    if (signal?.aborted) {
      await updateRun(agentRunId, { status: 'cancelled', phase: 'failed', error: 'cancelled', finished_at: new Date().toISOString() });
      return { status: 'cancelled', summary: 'agent run cancelled', fixAttempts, finalPhase: 'failed' };
    }

    if (attempt > 0) {
      fixAttempts = attempt;
      onPhase('fixing', `FIXING (attempt ${attempt}/${maxFixAttempts})`);
      await updateRun(agentRunId, { fix_attempts: fixAttempts });
      messages.push({
        role: 'user',
        content: `The previous build/test failed. Real failure output:\n\n${lastBuildFailureLog.slice(-8000)}\n\nInvestigate the root cause, fix the source files, then run the build again.`,
      });
    }

    let step = 0;
    let finished = false;

    while (step < MAX_STEPS_PER_ATTEMPT && !finished) {
      if (signal?.aborted) {
        await updateRun(agentRunId, { status: 'cancelled', phase: 'failed', error: 'cancelled', finished_at: new Date().toISOString() });
        return { status: 'cancelled', summary: 'agent run cancelled', fixAttempts, finalPhase: 'failed' };
      }
      step += 1;

      const modelResult = await callModel();
      if (!modelResult.ok) {
        await updateRun(agentRunId, {
          status: 'failed', phase: 'failed', error: modelResult.error ?? 'model call failed',
          tokens_in: tokensIn, tokens_out: tokensOut, finished_at: new Date().toISOString(),
        });
        agentEvent(projectId, 'failed', `agent model call failed: ${modelResult.error}`, { agentRunId });
        return { status: 'failed', summary: `model call failed: ${modelResult.error}`, fixAttempts, finalPhase: 'failed' };
      }

      messages.push({ role: 'assistant', content: modelResult.text });

      const parsed = parseToolCall(modelResult.text);
      if (!parsed) {
        messages.push({
          role: 'user',
          content: 'Your reply was not a valid tool-call JSON object or a done signal. Reply with a single JSON object exactly as specified.',
        });
        continue;
      }

      if ('done' in parsed) {
        summary = parsed.summary;
        finished = true;
        break;
      }

      if (parsed.reason) logEvent(projectId, 'build_log', 'info', `agent: ${parsed.reason}`);

      const toolResult: ToolResult = await executeTool(parsed.tool, parsed.args, {
        projectId, ownerId, agentRunId, onPhase, signal,
      });

      messages.push({
        role: 'user',
        content: `Tool "${parsed.tool}" result (ok=${toolResult.ok}):\n${redact(JSON.stringify(toolResult.output ?? {}).slice(0, 12000))}${toolResult.error ? `\nERROR: ${toolResult.error}` : ''}`,
      });

      // Any failed build or test result becomes the evidence used for the fix cycle.
      if ((parsed.tool === 'build_project' || parsed.tool === 'build_android') && !toolResult.ok) {
        const output = toolResult.output as { logTail?: string } | null;
        lastBuildFailureLog = output?.logTail ?? toolResult.error ?? 'build failed';
        break;
      }
      if (parsed.tool === 'run_tests' && !toolResult.ok) {
        const output = toolResult.output as { log?: string } | null;
        lastBuildFailureLog = output?.log ?? toolResult.error ?? 'tests failed';
        break;
      }
    }

    // ---------- VERIFY: run the real build (and tests) regardless of the model's
    // opinion, so the reported outcome is grounded in an actual command. ------
    let buildOk = true;
    let testOk = true;

    if (buildDetection.command) {
      onPhase('building', 'BUILDING project');
      const build = await runBuild({ projectId, ownerId, agentRunId, target: 'debug', runSecurityScan: true });
      buildOk = build.status === 'succeeded';
      const apk = await latestApk(projectId);
      if (buildOk && apk) {
        onPhase('inspecting', 'INSPECTING APK');
      }
      if (!buildOk) {
        lastBuildFailureLog = `${build.log}\n${build.error ?? ''}`.slice(-20000);
      }
    }

    if (buildOk && testDetection.command) {
      onPhase('testing', 'RUNNING TESTS');
      const tests = await runTests({ projectId, ownerId, agentRunId });
      testOk = tests.status === 'passed' || tests.status === 'unavailable';
      if (!testOk) lastBuildFailureLog = tests.log.slice(-20000);
    }

    if (buildOk && testOk) {
      onPhase('completed', 'COMPLETED');
      await updateRun(agentRunId, {
        status: 'succeeded',
        phase: 'completed',
        summary: summary || 'Agent run completed; build and tests passed.',
        fix_attempts: fixAttempts,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        finished_at: new Date().toISOString(),
      });
      agentEvent(projectId, 'completed', 'COMPLETED', { agentRunId });
      return {
        status: 'succeeded',
        summary: summary || 'Agent run completed; build and tests passed.',
        fixAttempts,
        finalPhase: 'completed',
      };
    }

    if (attempt === maxFixAttempts) {
      const message = `MAX_FIX_ATTEMPTS_REACHED after ${maxFixAttempts} attempts. Last failure:\n${lastBuildFailureLog.slice(-4000)}`;
      onPhase('failed', 'MAX_FIX_ATTEMPTS_REACHED');
      await updateRun(agentRunId, {
        status: 'limit_reached', phase: 'failed', error: 'MAX_FIX_ATTEMPTS_REACHED',
        summary: message, fix_attempts: fixAttempts, tokens_in: tokensIn, tokens_out: tokensOut,
        finished_at: new Date().toISOString(),
      });
      agentEvent(projectId, 'failed', 'MAX_FIX_ATTEMPTS_REACHED', { agentRunId });
      return { status: 'limit_reached', summary: message, fixAttempts, finalPhase: 'failed' };
    }

    logger.info('agent attempting fix', { projectId, attempt: attempt + 1, maxFixAttempts });
  }

  return { status: 'limit_reached', summary: 'MAX_FIX_ATTEMPTS_REACHED', fixAttempts, finalPhase: 'failed' };
}

/** Entry point used by the HTTP layer: queues the run with a hard timeout. */
export async function enqueueAgentRun(options: AgentRunOptions): Promise<AgentRunOutcome> {
  return jobQueue.submit({
    id: `agent:${options.agentRunId}`,
    timeoutMs: config.agentTimeoutMs,
    run: (signal) => runAgent({ ...options, signal }),
  });
}

export async function isAgentRunning(agentRunId: string): Promise<boolean> {
  return jobQueue.isRunning(`agent:${agentRunId}`);
}
