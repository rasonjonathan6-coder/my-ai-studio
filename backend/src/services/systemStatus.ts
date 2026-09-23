/**
 * System status. Each probe actually executes a command or a query and reports
 * AVAILABLE / NOT_AVAILABLE / ERROR. No probe ever returns a fabricated PASS.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { config } from '../config/index.ts';
import { checkDatabase } from '../db/pool.ts';
import { openRouter } from './openrouter.ts';
import { dockerAvailable, resolveBackend } from './commandRunner.ts';

export type ProbeState = 'AVAILABLE' | 'NOT_AVAILABLE' | 'ERROR';

export interface Probe {
  name: string;
  state: ProbeState;
  version: string | null;
  detail: string | null;
}

function probe(command: string, args: string[], timeoutMs = 10000): Promise<{ ok: boolean; output: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, env: { PATH: process.env.PATH, HOME: process.env.HOME, JAVA_HOME: process.env.JAVA_HOME, ANDROID_HOME: process.env.ANDROID_HOME } }, (err, stdout, stderr) => {
      if (err) {
        const code = typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number' ? (err as unknown as { code: number }).code : null;
        resolve({ ok: false, output: `${stderr || err.message}`.trim(), code });
        return;
      }
      resolve({ ok: true, output: (`${stdout}${stderr}`).trim(), code: 0 });
    });
  });
}

async function toolProbe(name: string, cmd: string, args: string[], versionLine = 0): Promise<Probe> {
  let result;
  try {
    result = await probe(cmd, args);
  } catch (err) {
    return { name, state: 'ERROR', version: null, detail: err instanceof Error ? err.message : String(err) };
  }
  // Some tools print a banner before their version (Gradle prints a line of
  // dashes first), and some print version info to stderr. Strip both so the
  // probe reports the real version rather than decoration.
  const lines = `${result.output}`.split('\n').map((l) => l.trim());
  const meaningful = lines.filter((l) => l.length > 0 && !/^[-=*\s]+$/.test(l));
  if (!result.ok) {
    const notFound = /ENOENT|not found|No such file/i.test(result.output);
    return {
      name,
      state: notFound ? 'NOT_AVAILABLE' : 'ERROR',
      version: null,
      detail: meaningful[versionLine]?.slice(0, 200) ?? null,
    };
  }
  return { name, state: 'AVAILABLE', version: meaningful[versionLine]?.slice(0, 120) ?? null, detail: null };
}

async function pathProbe(name: string, dirPath: string, subPaths: string[] = []): Promise<Probe> {
  if (!dirPath) return { name, state: 'NOT_AVAILABLE', version: null, detail: 'path not configured' };
  for (const sub of subPaths) {
    try {
      await fs.access(`${dirPath}/${sub}`);
    } catch {
      return { name, state: 'NOT_AVAILABLE', version: null, detail: `missing ${sub} under ${dirPath}` };
    }
  }
  try {
    await fs.access(dirPath);
  } catch {
    return { name, state: 'NOT_AVAILABLE', version: null, detail: `not found: ${dirPath}` };
  }
  return { name, state: 'AVAILABLE', version: dirPath, detail: null };
}

export interface SystemStatus {
  ok: boolean;
  service: string;
  version: string;
  time: string;
  host: { platform: string; arch: string; cpus: number; hostname: string };
  memory: { totalBytes: number; freeBytes: number; usedPercent: number };
  disk: { path: string; totalBytes: number; freeBytes: number; usedPercent: number } | null;
  probes: Probe[];
  executionBackend: 'docker' | 'host';
  sandboxEnabled: boolean;
}

async function diskProbe(): Promise<SystemStatus['disk']> {
  try {
    const stats = await fs.statfs(config.workspaceRoot.replace(/\/projects$/, '') || process.cwd());
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedPercent = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0;
    return { path: config.workspaceRoot, totalBytes, freeBytes, usedPercent };
  } catch {
    return null;
  }
}

const SANDBOX_PROBE_TIMEOUT_MS = 25000;

/**
 * Runs a command inside the sandbox image and returns its combined output.
 * Used for toolchain probes so the reported state matches the environment the
 * agent's commands actually execute in.
 */
async function runSandboxCommand(command: string, timeoutMs = SANDBOX_PROBE_TIMEOUT_MS): Promise<{ ok: boolean; output: string; code: number | null }> {
  return new Promise((resolve) => {
    const args = [
      'run', '--rm', '--init', '--network', 'none', '--user', '1000:1000',
      ...config.sandbox.extraMounts.flatMap((m) => ['-v', m]),
      ...Object.entries(probeEnv()).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      config.sandbox.image,
      '/bin/sh', '-c', command,
    ];
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      if (err) {
        const code = typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number' ? (err as unknown as { code: number }).code : null;
        resolve({ ok: false, output, code });
        return;
      }
      resolve({ ok: true, output, code: 0 });
    });
  });
}

function probeEnv(): Record<string, string> {
  const androidHome = config.androidHome || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  const env: Record<string, string> = {
    // Mirrors the PATH used for real commands so a tool that works during a
    // build also probes as AVAILABLE (platform-tools holds adb).
    PATH: [
      ...(androidHome ? [`${androidHome}/platform-tools`, `${androidHome}/cmdline-tools/latest/bin`] : []),
      '/usr/local/bin', '/usr/bin', '/bin',
    ].join(':'),
  };
  if (androidHome) env.ANDROID_HOME = androidHome;
  if (androidHome) env.ANDROID_SDK_ROOT = androidHome;
  return env;
}

/**
 * Interprets a sandbox probe. A missing binary surfaces as exit code 127 and a
 * "not found" message rather than ENOENT, because the command ran through a
 * shell, so both signals are treated as NOT_AVAILABLE.
 */
function sandboxProbeResult(name: string, result: { ok: boolean; output: string; code: number | null }, versionPattern?: RegExp): Probe {
  if (result.ok) {
    const version = versionPattern ? (result.output.match(versionPattern)?.[0] ?? null) : (result.output.split('\n')[0] ?? null);
    return { name, state: 'AVAILABLE', version: version?.slice(0, 120) ?? null, detail: null };
  }
  const notFound = result.code === 127 || /not found|No such file|executable file not found/i.test(result.output);
  return {
    name,
    state: notFound ? 'NOT_AVAILABLE' : 'ERROR',
    version: null,
    detail: (result.output.split('\n').filter((l) => l.trim()).slice(-1)[0] ?? null)?.slice(0, 200) ?? null,
  };
}

async function sandboxToolProbe(name: string, cmd: string, args: string[]): Promise<Probe> {
  const result = await runSandboxCommand([cmd, ...args].join(' '));
  return sandboxProbeResult(name, result);
}

async function sandboxJavaProbe(): Promise<Probe> {
  const result = await runSandboxCommand('java -version');
  return sandboxProbeResult('java', result, /version "[^"]+"/);
}

async function sandboxSdkProbe(androidHome: string): Promise<Probe> {
  if (!androidHome) return { name: 'androidSdk', state: 'NOT_AVAILABLE', version: null, detail: 'ANDROID_HOME not configured' };
  const result = await runSandboxCommand(`test -d ${androidHome}/platform-tools && test -d ${androidHome}/build-tools && echo ok`);
  if (!result.ok) {
    return { name: 'androidSdk', state: 'NOT_AVAILABLE', version: null, detail: `missing platform-tools/build-tools under ${androidHome} (in sandbox)` };
  }
  return { name: 'androidSdk', state: 'AVAILABLE', version: androidHome, detail: null };
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const androidHome = config.androidHome || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  const javaHome = config.javaHome || process.env.JAVA_HOME || '';

  const backend = await resolveBackend('auto');

  // When the docker backend is active, agent commands run inside the sandbox
  // image, not in this process. A toolchain probe must therefore look where the
  // commands will actually execute. Probing only the backend image reports
  // NOT_AVAILABLE for Gradle and the SDK even while a build is succeeding, which
  // makes the Build Center lie to the user.
  const inSandbox = backend === 'docker';
  const probeTool = inSandbox
    ? (name: string, cmd: string, args: string[]) => sandboxToolProbe(name, cmd, args)
    : (name: string, cmd: string, args: string[]) => toolProbe(name, cmd, args);

  const [node, java, git, docker, gradle, adb, python] = await Promise.all([
    toolProbe('node', 'node', ['--version']),
    inSandbox
      ? sandboxJavaProbe()
      : javaHome
        ? pathProbe('java', javaHome, ['bin/java'])
        : toolProbe('java', 'java', ['-version']),
    toolProbe('git', 'git', ['--version']),
    toolProbe('docker', 'docker', ['--version']),
    probeTool('gradle', 'gradle', ['--version']),
    probeTool('adb', 'adb', ['version']),
    probeTool('python', 'python3', ['--version']),
  ]);

  const androidSdk = inSandbox
    ? await sandboxSdkProbe(androidHome)
    : await pathProbe('androidSdk', androidHome, ['platform-tools', 'build-tools']);
  const [database, dockerUp] = await Promise.all([checkDatabase(), dockerAvailable()]);

  const dbProbe: Probe = !database.configured
    ? { name: 'postgres', state: 'NOT_AVAILABLE', version: null, detail: 'DATABASE_URL not configured' }
    : database.connected
      ? { name: 'postgres', state: 'AVAILABLE', version: (database.version ?? '').split(' ').slice(0, 2).join(' '), detail: null }
      : { name: 'postgres', state: 'ERROR', version: null, detail: database.error };

  const dockerProbe: Probe = docker.state === 'AVAILABLE'
    ? dockerUp
      ? { ...docker, state: 'AVAILABLE', detail: 'daemon reachable' }
      : { name: 'docker', state: 'ERROR', version: docker.version, detail: 'CLI present but daemon unreachable' }
    : docker;

  const orStatus = openRouter.status();
  const openRouterProbe: Probe = orStatus.configured
    ? { name: 'openrouter', state: 'AVAILABLE', version: orStatus.model, detail: 'API key configured (value hidden)' }
    : { name: 'openrouter', state: 'NOT_AVAILABLE', version: orStatus.model, detail: 'OPENROUTER_API_KEY not configured' };

  // An emulator needs a device actually attached, not just the adb binary.
  // The check runs where commands execute, so sandbox adb is consulted when the
  // docker backend is active.
  let emulatorProbe: Probe = { name: 'androidEmulator', state: 'NOT_AVAILABLE', version: null, detail: 'adb not available' };
  if (adb.state === 'AVAILABLE') {
    const devices = inSandbox
      ? await runSandboxCommand('adb devices', 20000)
      : await probe('adb', ['devices'], 15000);
    const attached = devices.ok
      ? devices.output.split('\n').slice(1).filter((l) => /\t(device|emulator)/.test(l))
      : [];
    emulatorProbe = attached.length > 0
      ? { name: 'androidEmulator', state: 'AVAILABLE', version: `${attached.length} device(s)`, detail: attached.map((l) => l.split('\t')[0]).join(',') }
      : { name: 'androidEmulator', state: 'NOT_AVAILABLE', version: null, detail: 'adb present but no emulator/device attached' };
  }

  const total = os.totalmem();
  const free = os.freemem();
  const disk = await diskProbe();

  return {
    ok: true,
    service: 'my-ai-studio',
    version: '1.0.0',
    time: new Date().toISOString(),
    host: { platform: `${os.type()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length, hostname: os.hostname() },
    memory: { totalBytes: total, freeBytes: free, usedPercent: Math.round(((total - free) / total) * 100) },
    disk,
    probes: [
      node, java, git, dockerProbe, gradle, adb, androidSdk, python,
      dbProbe, openRouterProbe, emulatorProbe,
    ],
    executionBackend: backend,
    sandboxEnabled: config.sandbox.enabled,
  };
}

export async function probeEnvironment(): Promise<Record<string, Probe>> {
  const status = await getSystemStatus();
  const map: Record<string, Probe> = {};
  for (const p of status.probes) map[p.name] = p;
  return map;
}
