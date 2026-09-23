/**
 * Real command execution. Output is captured from an actual child process;
 * nothing here fabricates stdout/stderr/exit codes.
 *
 * Two backends:
 *  - docker: runs the command inside an ephemeral container with the project
 *    directory bind-mounted, non-root user, resource limits, no docker socket.
 *  - host:   runs the command directly via /bin/sh in the project directory.
 *
 * The host backend is a fallback. It still enforces timeouts, output caps and
 * an environment allowlist, but it does NOT provide filesystem isolation. Report
 * the backend used so callers never imply sandboxing that is not there.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { config } from '../config/index.ts';
import { logger, redact } from '../lib/logger.ts';

export type ExecutionBackend = 'docker' | 'host';

export interface RunOptions {
  cwd: string;
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  backend?: ExecutionBackend | 'auto';
  env?: Record<string, string>;
  onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Host-backend safety: refuse when the command matches a deny pattern. */
  enforceDenylist?: boolean;
}

export interface RunResult {
  command: string;
  backend: ExecutionBackend;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  status: 'succeeded' | 'failed' | 'timeout';
}

/**
 * Guardrail for the host backend. This is defence in depth only, not a
 * sandbox; the docker backend is the real isolation boundary.
 */
const HOST_DENY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /rm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/, reason: 'refusing rm on /' },
  { re: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(\/|~|\$HOME)(\s|$)/, reason: 'refusing recursive delete outside project' },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, reason: 'fork bomb' },
  { re: /\bmkfs\b|\bdd\s+if=.*of=\/dev\//, reason: 'destructive disk operation' },
  { re: /\/var\/run\/docker\.sock|\bdocker\s+(run|exec|[a-z]+)/, reason: 'docker socket / nested docker access' },
  { re: /\bsudo\b|\bsu\s+-/, reason: 'privilege escalation' },
  { re: /\/etc\/(passwd|shadow|sudoers)/, reason: 'system credential access' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'host power control' },
  { re: /(^|\s)(nc|ncat|telnet)\s+.*-e\s+/, reason: 'reverse shell' },
  { re: /curl[^|]*\|\s*(ba)?sh/, reason: 'pipe-to-shell download' },
  { re: /wget[^|]*\|\s*(ba)?sh/, reason: 'pipe-to-shell download' },
];

export function hostDenyReason(command: string): string | null {
  for (const { re, reason } of HOST_DENY_PATTERNS) {
    if (re.test(command)) return reason;
  }
  return null;
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  // Allowlist: never inherit the server's process.env, which holds secrets.
  const allowed = [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'JAVA_HOME',
    'ANDROID_HOME',
    'ANDROID_SDK_ROOT',
    'GRADLE_USER_HOME',
    'TERM',
  ];
  const env: Record<string, string> = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH = env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  env.HOME = env.HOME ?? '/tmp';
  env.TERM = 'dumb';
  env.CI = '1';
  // Do not let the toolchain try to talk to a daemon that is not available.
  env.GRADLE_OPTS = env.GRADLE_OPTS ?? '-Dorg.gradle.daemon=false';
  return { ...env, ...extra };
}

/**
 * Environment that lets Gradle find the JDK, the Android SDK and a writable
 * user home. Both the docker backend (passed via `docker run -e`) and the host
 * backend need it, and leaving it out produces the classic
 * "SDK location not found" failure, so build and test share this.
 *
 * The Gradle home is verified to be writable by the execution backend before it
 * is advertised. A bind-mounted cache directory that is missing or owned by
 * another uid makes Gradle fail while creating its wrapper lock file, which
 * looks like a build error even though the project is fine, so an unusable
 * cache is replaced with an in-container path and the fallback is logged.
 */
export async function toolchainEnv(): Promise<Record<string, string>> {
  const base: Record<string, string> = {
    ...(config.androidHome ? { ANDROID_HOME: config.androidHome, ANDROID_SDK_ROOT: config.androidHome } : {}),
    ...(config.javaHome ? { JAVA_HOME: config.javaHome } : {}),
    GRADLE_USER_HOME: config.gradleUserHome,
  };

  // adb, aapt2 and apksigner live under platform-tools and build-tools and are
  // not on the default PATH, so a build could succeed while `inspect` reported
  // the SDK as missing. PATH is set explicitly (never inherited) to keep the
  // server's own environment out of the sandbox.
  const pathParts = [
    ...(config.androidHome ? [`${config.androidHome}/platform-tools`, `${config.androidHome}/cmdline-tools/latest/bin`] : []),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  base.PATH = pathParts.join(':');

  const backend = await resolveBackend('auto');
  if (backend === 'docker' && config.gradleUserHome && !(await sandboxDirWritable(config.gradleUserHome))) {
    logger.warn('configured GRADLE_USER_HOME is not writable in the sandbox; using an ephemeral cache', {
      configured: config.gradleUserHome,
    });
    base.GRADLE_USER_HOME = SANDBOX_FALLBACK_GRADLE_HOME;
  }

  return base;
}

/** In-sandbox home used when the mounted Gradle cache cannot be written to. */
const SANDBOX_FALLBACK_GRADLE_HOME = '/tmp/gradle-home';

const writableDirCache = new Map<string, Promise<boolean>>();

/**
 * Probes whether `dir` is writable inside the sandbox. The result is cached per
 * path because the probe costs a container start and the answer only changes
 * when the operator remounts the volume.
 */
function sandboxDirWritable(dir: string): Promise<boolean> {
  const cached = writableDirCache.get(dir);
  if (cached) return cached;

  const probe = new Promise<boolean>((resolve) => {
    const child = spawn(
      'docker',
      [
        'run', '--rm', '--network', 'none', '--user', '1000:1000',
        ...config.sandbox.extraMounts.flatMap((m) => ['-v', m]),
        config.sandbox.image,
        '/bin/sh', '-c', `mkdir -p ${shellQuote(dir)} && test -w ${shellQuote(dir)}`,
      ],
      { stdio: 'ignore' },
    );
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    setTimeout(() => child.kill('SIGKILL'), 15000).unref();
  });

  writableDirCache.set(dir, probe);
  return probe;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && out.trim().length > 0));
    setTimeout(() => child.kill('SIGKILL'), 8000).unref();
  });
}

export async function dockerImageExists(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

export async function resolveBackend(preferred: ExecutionBackend | 'auto'): Promise<ExecutionBackend> {
  if (preferred === 'host') return 'host';
  if (!config.sandbox.enabled) return 'host';
  if (!(await dockerAvailable())) return 'host';
  if (!(await dockerImageExists(config.sandbox.image))) {
    if (preferred === 'docker') {
      throw new Error(`SANDBOX_IMAGE ${config.sandbox.image} not found; build it with: docker build -f Dockerfile.sandbox -t ${config.sandbox.image} .`);
    }
    return 'host';
  }
  return 'docker';
}

export async function runCommand(options: RunOptions): Promise<RunResult> {
  const backend = await resolveBackend(options.backend ?? 'auto');
  const timeoutMs = options.timeoutMs ?? config.commandTimeoutMs;
  const maxOutput = options.maxOutputBytes ?? config.maxOutputBytes;
  const started = Date.now();

  if (options.enforceDenylist !== false && backend === 'host') {
    const reason = hostDenyReason(options.command);
    if (reason) {
      const durationMs = Date.now() - started;
      const stdout = '';
      const stderr = `BLOCKED BY POLICY: ${reason}\nCommand was not executed.\n`;
      logger.warn('command blocked by host policy', { reason });
      options.onChunk?.('stderr', stderr);
      return {
        command: options.command,
        backend,
        cwd: options.cwd,
        stdout,
        stderr,
        exitCode: 126,
        durationMs,
        truncated: false,
        timedOut: false,
        status: 'failed',
      };
    }
  }

  await fs.mkdir(options.cwd, { recursive: true }).catch(() => undefined);

  const isDocker = backend === 'docker';
  // `-c`, not `-lc`: a login shell sources /etc/profile, which overwrites PATH
  // and hides toolchains the backend deliberately put on it (Gradle, the Android
  // SDK). The environment passed below is the authoritative PATH.
  const args = isDocker
    ? [
        'run', '--rm', '--init',
        '--network', config.sandbox.networkDisabled ? 'none' : 'bridge',
        '--memory', config.sandbox.memoryLimit,
        '--cpus', config.sandbox.cpuLimit,
        '--pids-limit', String(config.sandbox.pidsLimit),
        '--user', '1000:1000',
        '--workdir', '/workspace',
        '--tmpfs', '/tmp:rw,exec,size=512m',
        '-v', `${options.cwd}:/workspace:rw`,
        ...config.sandbox.extraMounts.flatMap((m) => ['-v', m]),
        ...Object.entries(options.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        config.sandbox.image,
        '/bin/sh', '-c', options.command,
      ]
    : ['/bin/sh', '-c', options.command];

  const child = spawn(isDocker ? 'docker' : '/bin/sh', isDocker ? args : ['-c', options.command], {
    cwd: isDocker ? undefined : options.cwd,
    env: isDocker ? { PATH: process.env.PATH ?? '/usr/bin:/bin' } : baseEnv(options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isDocker,
  });

  let stdout = '';
  let stderr = '';
  let truncated = false;
  let timedOut = false;

  const append = (stream: 'stdout' | 'stderr', text: string): void => {
    const current = stream === 'stdout' ? stdout : stderr;
    if (current.length >= maxOutput) {
      truncated = true;
      return;
    }
    const room = maxOutput - current.length;
    const slice = text.length > room ? text.slice(0, room) : text;
    if (slice.length < text.length) truncated = true;
    if (stream === 'stdout') stdout += slice;
    else stderr += slice;
    options.onChunk?.(stream, slice);
  };

  child.stdout.on('data', (d: Buffer) => append('stdout', d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => append('stderr', d.toString('utf8')));

  const killTree = (): void => {
    try {
      if (isDocker) child.kill('SIGTERM');
      else if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const exitCode: number | null = await new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    child.on('error', (err: Error) => {
      append('stderr', `\n[runner] failed to start: ${err.message}\n`);
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
  if (timer) clearTimeout(timer);

  const durationMs = Date.now() - started;
  const status: RunResult['status'] = timedOut ? 'timeout' : exitCode === 0 ? 'succeeded' : 'failed';

  const result: RunResult = {
    command: options.command,
    backend,
    cwd: options.cwd,
    stdout: redact(stdout),
    stderr: redact(stderr),
    exitCode,
    durationMs,
    truncated,
    timedOut,
    status,
  };

  logger.info('command finished', {
    backend,
    exitCode,
    durationMs,
    status,
    truncated,
    timedOut,
    commandPreview: result.command.slice(0, 200),
  });

  return result;
}
