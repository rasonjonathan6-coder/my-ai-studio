/**
 * Secret scanner. Scans real project files and, when available, the contents of
 * a real APK. The APK is read with the in-process ZIP reader rather than the
 * system `unzip` binary, so the archive is scanned even on images where `unzip`
 * is absent. Reported matches are always masked so the scanner never becomes the
 * leak it is looking for.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceService } from './workspace.ts';
import { readZipEntries, readZipEntry } from '../lib/apkZip.ts';

export interface Finding {
  pattern: string;
  file: string;
  line: number;
  masked: string;
}

export interface ScanResult {
  status: 'clean' | 'findings' | 'error';
  filesScanned: number;
  findings: Finding[];
  apkScanned: boolean;
  apkNote: string | null;
  error: string | null;
}

interface PatternDef {
  name: string;
  re: RegExp;
  /** Optional guard to cut false positives in documentation/config examples. */
  allowInExample?: boolean;
}

const PATTERNS: PatternDef[] = [
  { name: 'OPENROUTER_API_KEY', re: /OPENROUTER_API_KEY\s*[=:]\s*["']?([^\s"']{8,})/g },
  { name: 'GEMINI_API_KEY', re: /GEMINI_API_KEY\s*[=:]\s*["']?([^\s"']{8,})/g },
  { name: 'GROQ_API_KEY', re: /GROQ_API_KEY\s*[=:]\s*["']?([^\s"']{8,})/g },
  { name: 'sk-or-key', re: /sk-or-[A-Za-z0-9_-]{16,}/g },
  { name: 'groq-key', re: /gsk_[A-Za-z0-9]{20,}/g },
  { name: 'google-aq-key', re: /AQ\.[A-Za-z0-9_-]{20,}/g },
  { name: 'openrouter-host', re: /openrouter\.ai\/api\/v1\/chat\/completions/g, allowInExample: true },
  { name: 'password=', re: /password\s*=\s*["']?([^\s"'#,;]{6,})/gi },
  { name: 'secret=', re: /secret\s*=\s*["']?([^\s"'#,;]{6,})/gi },
  { name: 'api_key=', re: /api[_-]?key\s*[=:]\s*["']?([^\s"'#,;]{8,})/gi },
  { name: 'apikey=', re: /apikey\s*[=:]\s*["']?([^\s"'#,;]{8,})/gi },
  { name: 'token=', re: /\btoken\s*[=:]\s*["']?([A-Za-z0-9._-]{16,})/gi },
  { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
];

const IGNORED_DIRS = new Set(['node_modules', '.git', '.gradle', 'build', '.cache', 'dist']);
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.kt', '.java', '.xml', '.gradle',
  '.properties', '.md', '.txt', '.yml', '.yaml', '.sh', '.env', '.cfg', '.ini', '.toml',
  '.html', '.css', '.swift', '.py', '.rb', '.go',
]);

/** Mask everything except a short prefix so logs never carry a live secret. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(20, value.length - 8))}${value.slice(-4)}`;
}

async function collectFiles(root: string, relDir = '.', acc: string[] = []): Promise<string[]> {
  const dir = path.join(root, relDir);
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const dirent of dirents) {
    if (IGNORED_DIRS.has(dirent.name) || dirent.name.startsWith('.env')) continue;
    const relChild = relDir === '.' ? dirent.name : `${relDir}/${dirent.name}`;
    const abs = path.join(root, relChild);
    let stat;
    try {
      stat = await fs.lstat(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) await collectFiles(root, relChild, acc);
    else if (stat.size > 0 && stat.size < 5 * 1024 * 1024 && TEXT_EXT.has(path.extname(dirent.name).toLowerCase())) {
      acc.push(relChild);
    }
  }
  return acc;
}

export async function scanProject(projectId: string, apkPath?: string | null): Promise<ScanResult> {
  const ws = new WorkspaceService(projectId);
  const findings: Finding[] = [];
  let filesScanned = 0;
  let apkScanned = false;
  let apkNote: string | null = null;

  try {
    const files = await collectFiles(ws.root);
    for (const relFile of files) {
      let content: string;
      try {
        content = await fs.readFile(path.join(ws.root, relFile), 'utf8');
      } catch {
        continue;
      }
      filesScanned += 1;
      const lines = content.split('\n');
      for (const def of PATTERNS) {
        const re = new RegExp(def.re.source, def.re.flags);
        for (let i = 0; i < lines.length; i += 1) {
          re.lastIndex = 0;
          const match = re.exec(lines[i]);
          if (!match) continue;
          const captured = match[1] ?? match[0];
          // Placeholder values in example files are not live credentials.
          if (isPlaceholder(captured)) continue;
          findings.push({
            pattern: def.name,
            file: relFile,
            line: i + 1,
            masked: maskSecret(captured),
          });
        }
      }
    }
  } catch (err) {
    return {
      status: 'error',
      filesScanned,
      findings,
      apkScanned: false,
      apkNote: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (apkPath) {
    const apkResult = await scanApk(apkPath);
    apkScanned = apkResult.scanned;
    apkNote = apkResult.note;
    findings.push(...apkResult.findings);
  }

  return {
    status: findings.length > 0 ? 'findings' : 'clean',
    filesScanned,
    findings,
    apkScanned,
    apkNote,
    error: null,
  };
}

function isPlaceholder(value: string): boolean {
  return /^(your|example|xxx|placeholder|changeme|<|\.\.\.|\$\{)/i.test(value) ||
    /^(REDACTED|TODO|NONE|NULL)$/i.test(value);
}

async function scanApk(apkPath: string): Promise<{ scanned: boolean; note: string | null; findings: Finding[] }> {
  const findings: Finding[] = [];
  let archive: Buffer;
  try {
    const stat = await fs.stat(apkPath);
    // An APK is a ZIP; refuse anything implausibly large before reading it in.
    if (stat.size > 512 * 1024 * 1024) {
      return { scanned: false, note: `APK is ${stat.size} bytes, above the scan limit`, findings };
    }
    archive = await fs.readFile(apkPath);
  } catch {
    return { scanned: false, note: `APK not found at ${apkPath}`, findings };
  }

  // The contents are read with the in-process ZIP reader rather than the system
  // `unzip` binary, which is absent from slim images and would leave the APK
  // unscanned while still reporting a clean project scan.
  const read = readZipEntries(archive);
  if (!read.ok) {
    return { scanned: false, note: `APK could not be read as an archive: ${read.error ?? 'unknown error'}`, findings };
  }

  const entries = read.entries.map((e) => e.name);
  const textish = entries.filter((e) => /\.(xml|properties|txt|json|js|kt|java|dex)$/i.test(e)).slice(0, 400);

  for (const entry of textish) {
    const bytes = readZipEntry(archive, entry);
    if (!bytes || bytes.length === 0) continue;
    // `.dex` and binary XML hold compressed strings; search the readable byte
    // sequences rather than claiming to have decoded binary formats. latin1
    // keeps every byte mapped so no match is dropped by UTF-8 replacement.
    const haystack = bytes.toString('latin1');
    for (const def of PATTERNS) {
      const re = new RegExp(def.re.source, def.re.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(haystack)) !== null) {
        const captured = match[1] ?? match[0];
        if (isPlaceholder(captured)) continue;
        findings.push({
          pattern: `${def.name} (apk:${entry})`,
          file: `apk:${entry}`,
          line: 0,
          masked: maskSecret(captured),
        });
        if (findings.length > 200) break;
      }
    }
  }

  return {
    scanned: true,
    note: `scanned ${textish.length} text-like entries out of ${entries.length}`,
    findings,
  };
}
