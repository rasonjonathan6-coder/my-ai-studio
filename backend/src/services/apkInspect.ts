/**
 * APK inspection. Uses the real Android build-tools when they are present
 * (aapt2 / apkanalyzer / apksigner) and always falls back to real ZIP parsing
 * of AndroidManifest.xml + META-INF entries. Anything that cannot be
 * determined is reported as null with an explicit note rather than guessed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config/index.ts';
import { sha256File } from '../lib/hash.ts';
import { parseBinaryManifest } from '../lib/axml.ts';
import { readZipEntries, readZipEntry } from '../lib/apkZip.ts';

export interface ApkInspection {
  path: string;
  exists: boolean;
  sizeBytes: number | null;
  sha256: string | null;
  packageName: string | null;
  versionName: string | null;
  versionCode: string | null;
  minSdk: string | null;
  targetSdk: string | null;
  permissions: string[];
  activities: string[];
  services: string[];
  receivers: string[];
  providers: string[];
  /** Launcher activity, when the manifest declares one. */
  mainActivity: string | null;
  /** Whether the binary manifest was actually decoded. */
  manifestRead: boolean;
  cleartextTraffic: boolean | null;
  abis: string[];
  nativeLibs: string[];
  dexFiles: number | null;
  signed: boolean | null;
  signatureSchemes: string[];
  debugBuild: boolean | null;
  toolsUsed: string[];
  notes: string[];
}

function exec(cmd: string, args: string[], timeoutMs = 120000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

async function findBuildTool(name: string): Promise<string | null> {
  const sdk = config.androidHome || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  if (!sdk) return null;
  const buildToolsRoot = path.join(sdk, 'build-tools');
  try {
    const versions = (await fs.readdir(buildToolsRoot)).sort().reverse();
    for (const v of versions) {
      const candidate = path.join(buildToolsRoot, v, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function inspectApk(apkPath: string): Promise<ApkInspection> {
  const result: ApkInspection = {
    path: apkPath,
    exists: false,
    sizeBytes: null,
    sha256: null,
    packageName: null,
    versionName: null,
    versionCode: null,
    minSdk: null,
    targetSdk: null,
    permissions: [],
    activities: [],
    services: [],
    receivers: [],
    providers: [],
    mainActivity: null,
    manifestRead: false,
    cleartextTraffic: null,
    abis: [],
    nativeLibs: [],
    dexFiles: null,
    signed: null,
    signatureSchemes: [],
    debugBuild: null,
    toolsUsed: [],
    notes: [],
  };

  let stat;
  try {
    stat = await fs.stat(apkPath);
  } catch {
    result.notes.push(`APK does not exist at ${apkPath}`);
    return result;
  }
  if (!stat.isFile() || stat.size === 0) {
    result.notes.push('APK path exists but is not a non-empty file');
    return result;
  }
  result.exists = true;
  result.sizeBytes = stat.size;
  result.sha256 = await sha256File(apkPath);

  // --- authoritative metadata via aapt2 when available -----------------------
  const aapt2 = await findBuildTool('aapt2');
  if (aapt2) {
    const dump = await exec(aapt2, ['dump', 'badging', apkPath]);
    if (dump.ok) {
      result.toolsUsed.push('aapt2');
      const text = dump.stdout;
      result.packageName = /package: name='([^']+)'/.exec(text)?.[1] ?? result.packageName;
      result.versionCode = /versionCode='([^']+)'/.exec(text)?.[1] ?? result.versionCode;
      result.versionName = /versionName='([^']*)'/.exec(text)?.[1] ?? result.versionName;
      result.minSdk = /sdkVersion:'([^']+)'/.exec(text)?.[1] ?? result.minSdk;
      result.targetSdk = /targetSdkVersion:'([^']+)'/.exec(text)?.[1] ?? result.targetSdk;
      result.permissions = [...text.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1]);
      result.activities = [...text.matchAll(/launchable-activity: name='([^']+)'/g)].map((m) => m[1]);
      result.debugBuild = /application-debuggable/.test(text) ? true : null;
      const natives = [...text.matchAll(/native-code: '([^']+)'/g)].map((m) => m[1]);
      result.abis = natives;
    } else {
      result.notes.push(`aapt2 dump badging failed: ${dump.stderr.trim().slice(0, 200)}`);
    }
  } else {
    result.notes.push('aapt2 not found in Android SDK build-tools; parsed APK contents directly');
  }

  // --- ZIP structure + manifest strings (always real, works without SDK) -----
  // Read with the in-process ZIP reader: the system `unzip` binary is absent from
  // slim images, and its failure would silently leave the archive unexamined.
  let entryNames: string[] = [];
  let apkBuffer: Buffer | null = null;
  try {
    apkBuffer = await fs.readFile(apkPath);
    const read = readZipEntries(apkBuffer);
    if (read.ok) {
      entryNames = read.entries.map((e) => e.name);
      result.toolsUsed.push('zipreader');
      result.nativeLibs = entryNames.filter((e) => e.endsWith('.so'));
      result.abis = result.abis.length > 0
        ? result.abis
        : [...new Set(result.nativeLibs.map((e) => e.split('/').slice(-2)[0]).filter(Boolean))];
      result.dexFiles = entryNames.filter((e) => /^classes\d*\.dex$/.test(path.basename(e))).length;
    } else {
      result.notes.push(`APK could not be read as an archive: ${read.error ?? 'unknown error'}`);
    }
  } catch (err) {
    result.notes.push(`APK could not be read: ${(err as Error).message.slice(0, 200)}`);
  }

  const manifestEntry = entryNames.find((e) => e === 'AndroidManifest.xml' || e.endsWith('/AndroidManifest.xml'));
  const manifestContent = apkBuffer && manifestEntry ? readZipEntry(apkBuffer, manifestEntry) : null;
  if (manifestContent && manifestContent.length > 0) {
    const parsed = parseBinaryManifest(manifestContent);
    if (parsed) {
      result.toolsUsed.push('axml');
      // aapt2 output is authoritative when it ran; the parser only fills gaps.
      if (!result.packageName) result.packageName = parsed.packageName;
      if (!result.versionName) result.versionName = parsed.versionName;
      if (!result.versionCode) result.versionCode = parsed.versionCode === null ? null : String(parsed.versionCode);
      if (!result.minSdk) result.minSdk = parsed.minSdk === null ? null : String(parsed.minSdk);
      if (!result.targetSdk) result.targetSdk = parsed.targetSdk === null ? null : String(parsed.targetSdk);
      if (result.permissions.length === 0) result.permissions = parsed.permissions;
      if (result.activities.length === 0) result.activities = parsed.activities;
      if (result.services.length === 0) result.services = parsed.services;
      if (result.receivers.length === 0) result.receivers = parsed.receivers;
      if (result.providers.length === 0) result.providers = parsed.providers;
      result.mainActivity = parsed.mainActivity;
      if (result.debugBuild === null && parsed.debuggable !== null) result.debugBuild = parsed.debuggable;
      result.cleartextTraffic = parsed.cleartextTraffic;
      result.manifestRead = true;
    } else {
      result.notes.push('AndroidManifest.xml is not a recognised binary AXML document; values left null rather than guessed');
    }
  } else {
    result.notes.push('AndroidManifest.xml could not be extracted from the APK');
  }

  // --- signature via apksigner when available -------------------------------
  const apksigner = await findBuildTool('apksigner');
  if (apksigner) {
    const verify = await exec(apksigner, ['verify', '--verbose', '--print-certs', apkPath]);
    const combined = `${verify.stdout}${verify.stderr}`;
    if (verify.ok) {
      result.toolsUsed.push('apksigner');
      result.signed = true;
      for (const scheme of ['v1', 'v2', 'v3', 'v3.1', 'v4']) {
        if (new RegExp(`Verified using ${scheme} scheme.*true`, 'i').test(combined)) {
          result.signatureSchemes.push(scheme);
        }
      }
      result.debugBuild = /Android Debug/i.test(combined) ? true : result.debugBuild;
    } else if (/not signed|DOES NOT VERIFY|Missing/i.test(combined)) {
      result.toolsUsed.push('apksigner');
      result.signed = false;
      result.notes.push(`apksigner reported the APK as unsigned/invalid: ${combined.split('\n')[0]?.slice(0, 200)}`);
    } else {
      result.notes.push(`apksigner failed to run: ${combined.trim().slice(0, 200)}`);
    }
  } else {
    // Presence of META-INF signing files is real evidence, not proof of validity.
    const signed = entryNames.some((e) => /^META-INF\/.*\.(RSA|DSA|EC|SF)$/i.test(e));
    result.signed = signed ? true : null;
    result.signatureSchemes = signed ? ['v1-or-unknown'] : [];
    result.notes.push('apksigner not available; signature inferred from META-INF entries only (validity NOT verified)');
  }

  if (result.debugBuild === null && /app-debug\.apk$/.test(apkPath)) {
    result.debugBuild = true;
    result.notes.push('debug status inferred from the app-debug.apk filename');
  }

  return result;
}
