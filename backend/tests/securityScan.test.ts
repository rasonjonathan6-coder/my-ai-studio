import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeZip } from '../src/lib/zipWriter.ts';
import { scanProject } from '../src/services/securityScan.ts';
import { config } from '../src/config/index.ts';

/**
 * Security scan tests.
 *
 * These run against real files on disk: a project workspace under the configured
 * workspace root, and a real APK-shaped archive holding a planted key. The point
 * is that both the file scan and the archive scan must find the secret - an APK
 * that is silently skipped would let a key ship while reporting `clean`.
 */

/** Creates a throwaway project workspace and returns its id. */
async function makeProject(): Promise<string> {
  const id = `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const dir = path.join(config.workspaceRoot, id);
  await fs.mkdir(dir, { recursive: true });
  return id;
}

async function cleanup(id: string): Promise<void> {
  await fs.rm(path.join(config.workspaceRoot, id), { recursive: true, force: true });
}

test('a literal secret in a project file is reported, masked and never echoed', async () => {
  const id = await makeProject();
  try {
    const dir = path.join(config.workspaceRoot, id);
    await fs.writeFile(path.join(dir, 'config.ts'), 'const k = "sk-or-v1-0123456789abcdef0123456789abcdef";\n');
    await fs.writeFile(path.join(dir, 'main.kt'), 'fun main() = println("hello")\n');

    const result = await scanProject(id);
    assert.equal(result.status, 'findings');
    assert.ok(result.filesScanned >= 2, `expected both files scanned, got ${result.filesScanned}`);

    const hit = result.findings.find((f) => f.file === 'config.ts');
    assert.ok(hit, 'the planted key must be reported');
    // The raw key must never appear in the report - only a masked form.
    const serialised = JSON.stringify(result);
    assert.equal(serialised.includes('0123456789abcdef0123456789abcdef'), false, 'the full secret leaked into the report');
    assert.ok(hit.masked.includes('*'), `expected a masked value, got ${hit.masked}`);
  } finally {
    await cleanup(id);
  }
});

test('a clean project reports clean, not a bogus finding', async () => {
  const id = await makeProject();
  try {
    const dir = path.join(config.workspaceRoot, id);
    await fs.writeFile(path.join(dir, 'README.md'), '# a normal project\n');
    await fs.writeFile(path.join(dir, 'app.ts'), 'const port = 8080;\n');

    const result = await scanProject(id);
    assert.equal(result.status, 'clean');
    assert.equal(result.findings.length, 0);
  } finally {
    await cleanup(id);
  }
});

test('a secret planted inside an APK is found by the archive scan', async () => {
  const id = await makeProject();
  try {
    // A real ZIP carrying the entries an APK has, one of which holds a key.
    const apkPath = path.join(os.tmpdir(), `planted-${Date.now()}.apk`);
    const archive = writeZip([
      { name: 'classes.dex', content: Buffer.from('dex\n035\0payload', 'latin1') },
      {
        name: 'res/values/strings.xml',
        content: Buffer.from('<resources><string name="apiKey">sk-or-v1-fedcba9876543210fedcba9876543210</string></resources>'),
      },
    ]);
    await fs.writeFile(apkPath, archive.buffer);

    const result = await scanProject(id, apkPath);
    assert.equal(result.apkScanned, true, `the APK must be scanned: ${result.apkNote}`);
    assert.equal(result.status, 'findings', 'the key inside the APK must be reported');

    const hit = result.findings.find((f) => f.file.startsWith('apk:'));
    assert.ok(hit, 'a finding attributed to the APK is required');
    assert.equal(JSON.stringify(result).includes('fedcba9876543210fedcba9876543210'), false, 'the full secret leaked');

    await fs.rm(apkPath, { force: true });
  } finally {
    await cleanup(id);
  }
});

test('an APK-shaped file that is not an archive is reported as unscanned, not clean', async () => {
  const id = await makeProject();
  try {
    const apkPath = path.join(os.tmpdir(), `broken-${Date.now()}.apk`);
    await fs.writeFile(apkPath, Buffer.from('this is not a zip archive at all'));

    const result = await scanProject(id, apkPath);
    assert.equal(result.apkScanned, false, 'a non-archive must not be reported as scanned');
    assert.ok(result.apkNote && result.apkNote.length > 0, 'the reason must be stated');
  } finally {
    await cleanup(id);
  }
});
