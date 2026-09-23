/**
 * Android preview. A preview only happens when a real emulator/device is
 * reachable through adb. With no device the result is NOT AVAILABLE and the
 * caller must surface that verbatim - there is no placeholder screenshot.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { config } from '../config/index.ts';

export interface PreviewResult {
  available: boolean;
  status: 'AVAILABLE' | 'NOT_AVAILABLE' | 'ERROR';
  devices: string[];
  installed: boolean;
  launched: boolean;
  packageName: string | null;
  logcat: string[];
  screenshots: string[];
  message: string;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
}

function adb(args: string[], timeoutMs = 60000): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message, code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

export async function checkEmulator(): Promise<{ available: boolean; devices: string[]; detail: string }> {
  const version = await adb(['version']);
  if (!version.ok) {
    return { available: false, devices: [], detail: `adb not available: ${version.stderr.trim().slice(0, 120)}` };
  }
  const devices = await adb(['devices']);
  if (!devices.ok) {
    return { available: false, devices: [], detail: `adb devices failed: ${devices.stderr.trim().slice(0, 120)}` };
  }
  const attached = devices.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => /\tdevice$/.test(l))
    .map((l) => l.split('\t')[0]);
  return {
    available: attached.length > 0,
    devices: attached,
    detail: attached.length > 0 ? `${attached.length} device(s) online` : 'adb present but no device/emulator is attached',
  };
}

export async function previewApk(input: { apkPath: string | null; packageName: string | null }): Promise<PreviewResult> {
  const steps: PreviewResult['steps'] = [];
  const emulator = await checkEmulator();
  steps.push({ step: 'adb devices', ok: emulator.available, detail: emulator.detail });

  if (!emulator.available) {
    return {
      available: false,
      status: 'NOT_AVAILABLE',
      devices: [],
      installed: false,
      launched: false,
      packageName: input.packageName,
      logcat: [],
      screenshots: [],
      message: `ANDROID PREVIEW: NOT AVAILABLE - ${emulator.detail}. Deploy an emulator host and point ADB at it, then retry.`,
      steps,
    };
  }

  if (!input.apkPath) {
    return {
      available: false,
      status: 'NOT_AVAILABLE',
      devices: emulator.devices,
      installed: false,
      launched: false,
      packageName: input.packageName,
      logcat: [],
      screenshots: [],
      message: 'ANDROID PREVIEW: NOT AVAILABLE - no APK has been built for this project yet',
      steps,
    };
  }

  try {
    await fs.access(input.apkPath);
  } catch {
    return {
      available: true,
      status: 'ERROR',
      devices: emulator.devices,
      installed: false,
      launched: false,
      packageName: input.packageName,
      logcat: [],
      screenshots: [],
      message: `ANDROID PREVIEW: ERROR - APK path does not exist: ${input.apkPath}`,
      steps,
    };
  }

  if (!config.androidHome && !process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
    // still attempt, but record that the SDK path is unset
    steps.push({ step: 'sdk path', ok: false, detail: 'ANDROID_HOME not set; relying on PATH lookups' });
  }

  const install = await adb(['install', '-r', input.apkPath], 180000);
  steps.push({ step: 'adb install -r', ok: install.ok, detail: (install.stdout + install.stderr).trim().slice(0, 300) });

  let packageName = input.packageName;
  if (!packageName) {
    const pm = await adb(['shell', 'pm', 'list', 'packages', '-3']);
    if (pm.ok) {
      const candidates = pm.stdout.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
      packageName = candidates[candidates.length - 1] ?? null;
    }
  }

  let launched = false;
  if (install.ok && packageName) {
    const launch = await adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], 60000);
    launched = launch.ok;
    steps.push({ step: 'launch activity', ok: launched, detail: (launch.stdout + launch.stderr).trim().slice(0, 300) });

    const capture = await adb(['exec-out', 'screencap', '-p'], 60000);
    if (capture.ok && capture.stdout.length > 0) {
      // adb writes through a pipe as text here; screenshots require a real
      // binary-safe transfer which is why we surface the limitation instead of
      // fabricating an image.
      steps.push({ step: 'screencap', ok: false, detail: 'binary screenshot transfer not captured through the text pipe; use adb pull separately' });
    }
  }

  const logcat = await adb(['logcat', '-d', '-t', '200'], 60000);
  const logLines = logcat.ok ? logcat.stdout.split('\n').slice(-200) : [];
  steps.push({ step: 'adb logcat -d', ok: logcat.ok, detail: `${logLines.length} lines captured` });

  return {
    available: true,
    status: install.ok ? 'AVAILABLE' : 'ERROR',
    devices: emulator.devices,
    installed: install.ok,
    launched,
    packageName,
    logcat: logLines,
    screenshots: [],
    message: install.ok
      ? `ANDROID PREVIEW: AVAILABLE - installed${launched ? ' and launched' : ''} ${packageName ?? ''} on ${emulator.devices.join(', ')}`
      : `ANDROID PREVIEW: ERROR - install failed: ${(install.stdout + install.stderr).trim().slice(0, 300)}`,
    steps,
  };
}
