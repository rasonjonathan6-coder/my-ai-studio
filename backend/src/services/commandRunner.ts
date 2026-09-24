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
import path from 'node:path';
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
 * Patterns refused on every backend. The docker sandbox is the real isolation
 * boundary, but it mounts the project at /workspace read-write, so a command
 * that wipes /workspace destroys the project it is supposed to be building.
 * These are the commands where the sandbox *is* the target.
 */
const ALWAYS_DENY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /rm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/, reason: 'refusing rm on /' },
  { re: /rm\s+(-[a-zA-Z]*\s+)*\/workspace\/?(\s|$)/, reason: 'refusing rm on the mounted project root' },
  { re: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(\/|~|\$HOME)(\s|$)/, reason: 'refusing recursive delete outside the project subtree' },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, reason: 'fork bomb' },
  { re: /\bmkfs\b|\bdd\s+if=.*of=\/dev\//, reason: 'destructive disk operation' },
  { re: /\/etc\/(passwd|shadow|sudoers)/, reason: 'system credential access' },
  { re: /(^|\s)(nc|ncat|telnet)\s+.*-e\s+/, reason: 'reverse shell' },
  { re: /curl[^|]*\|\s*(ba)?sh/, reason: 'pipe-to-shell download' },
  { re: /wget[^|]*\|\s*(ba)?sh/, reason: 'pipe-to-shell download' },
];

/**
 * Patterns refused only on the host backend, where the process can actually
 * reach the daemon, the package manager or init. Inside the sandbox these are
 * either impossible or harmless, so blocking them there would only break
 * legitimate build steps.
 */
const HOST_ONLY_DENY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\/var\/run\/docker\.sock|\bdocker\s+(run|exec|[a-z]+)/, reason: 'docker socket / nested docker access' },
  { re: /\bsudo\b|\bsu\s+-/, reason: 'privilege escalation' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'host power control' },
];

const HOST_DENY_PATTERNS = [...ALWAYS_DENY_PATTERNS, ...HOST_ONLY_DENY_PATTERNS];

export function hostDenyReason(command: string): string | null {
  for (const { re, reason } of HOST_DENY_PATTERNS) {
    if (re.test(command)) return reason;
  }
  return null;
}

export function sandboxDenyReason(command: string): string | null {
  for (const { re, reason } of ALWAYS_DENY_PATTERNS) {
    if (re.test(command)) return reason;
  }
  return null;
}

export function denyReasonFor(command: string, backend: ExecutionBackend): string | null {
  return backend === 'host' ? hostDenyReason(command) : sandboxDenyReason(command);
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

/**
 * Maps an in-container path to the path the Docker daemon will resolve it
 * against. The daemon runs on the host, so a sibling container's bind mount
 * source must be a host path. When the backend is containerised, WORKSPACE_PATH
 * is the in-container path and the host path of the same directory is supplied
 * separately via SANDBOX_WORKSPACE_HOST_PATH.
 */
export function toHostPath(containerPath: string): string {
  const containerRoot = config.workspaceRoot;
  const hostRoot = config.sandbox.workspaceHostPath;
  if (!hostRoot) return containerPath;
  if (containerPath !== containerRoot && !containerPath.startsWith(containerRoot + path.sep)) {
    // Outside the workspace tree there is no mapping to apply, so pass it through
    // unchanged rather than inventing one.
    return containerPath;
  }
  return path.posix.join(hostRoot, path.posix.relative(containerRoot, containerPath));
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

  // Falling back to the host backend is safe in development and unsafe in
  // production: the host backend runs commands in this process and can read its
  // environment file, which holds every provider key. The boot guard only checks
  // that SANDBOX_ENABLED is set, so without this a production host with a
  // missing image or an unreachable daemon would pass startup and then silently
  // execute agent commands on the host. Fail closed instead: an operator who
  // wants host execution in production has to say so explicitly.
  const failClosed = config.env === 'production' && !config.sandbox.hostExecutionAllowedInProduction;
  const refuse = (reason: string): never => {
    throw new Error(
      `Refusing to run commands: ${reason}. Production requires the Docker sandbox, because the ` +
        'host backend can read this process secrets. Fix the sandbox (build the image, start the ' +
        'daemon), or set ALLOW_HOST_EXECUTION_IN_PRODUCTION=true if this host is trusted and single-tenant.',
    );
  };

  if (!(await dockerAvailable())) {
    if (failClosed) refuse('the Docker daemon is unreachable');
    return 'host';
  }
  if (!(await dockerImageExists(config.sandbox.image))) {
    if (preferred === 'docker' || failClosed) {
      refuse(`SANDBOX_IMAGE ${config.sandbox.image} not found; build it with: docker build -f Dockerfile.sandbox -t ${config.sandbox.image} .`);
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

  if (options.enforceDenylist !== false) {
    const reason = denyReasonFor(options.command, backend);
    if (reason) {
      const durationMs = Date.now() - started;
      const stdout = '';
      const stderr = `BLOCKED BY POLICY: ${reason}\nCommand was not executed.\n`;
      logger.warn('command blocked by policy', { reason, backend });
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
        // Drop Linux capabilities and forbid regaining them. The sandbox runs
        // untrusted, model-authored commands, so it must not be able to
        // reconfigure interfaces, load modules or otherwise escalate.
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--workdir', '/workspace',
        '--tmpfs', '/tmp:rw,exec,size=512m',
        '-v', `${toHostPath(options.cwd)}:/workspace:rw`,
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
