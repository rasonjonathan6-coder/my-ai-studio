import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeZip } from '../src/lib/zipWriter.ts';
import { readZipEntries, readZipEntry } from '../src/lib/apkZip.ts';
import { crc32 } from '../src/lib/crc32.ts';
import { isExportable } from '../src/services/export.ts';

/**
 * Export and archive tests.
 *
 * The ZIP writer is exercised by writing an archive and reading it back with the
 * production reader, which independently inflates and verifies the central
 * directory. The exclusion rules are checked against the paths an export must
 * never carry, plus the near-miss names that must be kept.
 */

test('the CRC-32 helper matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('a written archive is readable by the production reader and round-trips content', () => {
  const big = Buffer.from('lorem ipsum '.repeat(5000), 'utf8');
  const entries = [
    { name: 'app/src/Main.kt', content: Buffer.from('fun main() {}\n'), mtime: new Date('2026-01-02T03:04:05Z') },
    { name: 'README.md', content: Buffer.from('# hi\n'), mtime: new Date('2026-01-02T03:04:05Z') },
    { name: 'data/blob.bin', content: big, store: true, mtime: new Date('2026-01-02T03:04:05Z') },
  ];

  const written = writeZip(entries);
  assert.equal(written.entryCount, 3);

  const read = readZipEntries(written.buffer);
  assert.equal(read.ok, true, read.error ?? '');
  assert.deepEqual(read.entries.map((e) => e.name).sort(), ['README.md', 'app/src/Main.kt', 'data/blob.bin']);

  const main = readZipEntry(written.buffer, 'app/src/Main.kt');
  assert.equal(main?.toString('utf8'), 'fun main() {}\n');

  const blob = readZipEntry(written.buffer, 'data/blob.bin');
  assert.equal(blob?.length, big.length, 'a stored entry must round-trip byte-for-byte');
  assert.equal(blob?.equals(big), true);

  const compressed = read.entries.find((e) => e.name === 'data/blob.bin');
  assert.equal(compressed?.compressionMethod, 0, 'store entries must not be deflated');
});

test('a deflated entry really is compressed', () => {
  const payload = Buffer.from('a'.repeat(100_000), 'utf8');
  const written = writeZip([{ name: 'x.txt', content: payload }]);
  assert.ok(
    written.buffer.length < payload.length / 10,
    `expected heavy compression, got ${written.buffer.length} bytes for ${payload.length}`,
  );
  const read = readZipEntries(written.buffer);
  assert.equal(read.ok, true, read.error ?? '');
  assert.equal(read.entries[0].compressedSize < read.entries[0].uncompressedSize, true);
  assert.equal(readZipEntry(written.buffer, 'x.txt')?.equals(payload), true);
});

test('an empty archive is still a valid ZIP', () => {
  const written = writeZip([]);
  assert.equal(written.entryCount, 0);
  const read = readZipEntries(written.buffer);
  assert.equal(read.ok, true, read.error ?? '');
  assert.equal(read.entries.length, 0);
});

test('a pre-1980 mtime is clamped instead of overflowing the DOS timestamp', () => {
  const written = writeZip([{ name: 'old.txt', content: Buffer.from('x'), mtime: new Date('1970-01-01T00:00:00Z') }]);
  const read = readZipEntries(written.buffer);
  assert.equal(read.ok, true, read.error ?? '');
  assert.equal(read.entries[0].name, 'old.txt');
});

// --------------------------------------------------------- exclusion rules
test('secrets, dependencies and build output are never exportable', () => {
  const excluded = [
    '.env', '.env.local', '.env.production', 'app/.env',
    'node_modules/react/index.js', 'app/node_modules/x.js',
    '.git/config', 'sub/.git/HEAD',
    'app/build/outputs/apk/debug/app-debug.apk',
    'dist/bundle.js', '.gradle/8.9/fileHashes.bin',
    'release/app-release.apk', 'release/app.aab',
    'keystore/release.jks', 'certs/key.pem', 'id_rsa.key',
    'config/secrets.json', 'config/credentials.yaml', 'secrets.env',
    'build.log', '__pycache__/x.pyc', 'coverage/lcov.info',
  ];
  for (const p of excluded) {
    assert.equal(isExportable(p), false, `${p} must be excluded from the export`);
  }
});

test('ordinary source and near-miss names are kept', () => {
  const kept = [
    'README.md', 'settings.gradle.kts', 'app/src/main/AndroidManifest.xml',
    // Near misses: the exclusion matches whole segments and exact stems, not
    // substrings, so these are ordinary files.
    'mynode_modules/keep.js', 'src/buildInfo.kt', 'build.gradle.kts',
    'secretsanta.txt', 'credentials_helper.ts', '.environment',
    'app/src/main/res/values/strings.xml',
  ];
  for (const p of kept) {
    assert.equal(isExportable(p), true, `${p} must be kept in the export`);
  }
});
