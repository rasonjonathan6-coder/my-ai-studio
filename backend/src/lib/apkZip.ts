/**
 * Minimal ZIP central-directory reader, plus the APK validation built on it.
 *
 * Android artifacts are ZIP archives. Rather than shelling out to `unzip`
 * (which is absent from the runtime image and therefore a silent failure waiting
 * to happen) the central directory is parsed directly: entries are located from
 * the end-of-central-directory record, deflate members are inflated with
 * node:zlib. A file that is not a ZIP, or whose central directory is truncated,
 * is reported as invalid instead of being assumed good.
 */
import { inflateRawSync } from 'node:zlib';
import { parseBinaryManifest } from './axml.ts';

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

export interface ZipReadResult {
  ok: boolean;
  entries: ZipEntry[];
  error?: string;
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;

/**
 * Parses the central directory. `maxEntries` bounds the work done on an
 * attacker-supplied archive: a member claiming a huge count is rejected rather
 * than iterated.
 */
export function readZipEntries(buf: Buffer, maxEntries = 20000): ZipReadResult {
  if (buf.length < 22) return { ok: false, entries: [], error: 'file is too small to be a zip archive' };

  // The EOCD is at the end, but a trailing comment can push it earlier.
  const searchStart = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= searchStart; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, entries: [], error: 'end of central directory record not found' };

  let entryCount = buf.readUInt16LE(eocd + 10);
  let centralOffset = buf.readUInt32LE(eocd + 16);

  // Zip64: when the classic fields are saturated the real values live in the
  // Zip64 record the locator points at.
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === EOCD64_LOCATOR_SIG) {
      const eocd64 = Number(buf.readBigUInt64LE(locator + 8));
      if (eocd64 >= 0 && eocd64 + 56 <= buf.length && buf.readUInt32LE(eocd64) === EOCD64_SIG) {
        entryCount = Number(buf.readBigUInt64LE(eocd64 + 32));
        centralOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
      }
    }
  }

  if (entryCount > maxEntries) {
    return { ok: false, entries: [], error: `archive declares ${entryCount} entries, above the ${maxEntries} limit` };
  }
  if (centralOffset < 0 || centralOffset >= buf.length) {
    return { ok: false, entries: [], error: 'central directory offset is outside the file' };
  }

  const entries: ZipEntry[] = [];
  let p = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      return { ok: false, entries, error: `central directory entry ${i} is truncated or malformed` };
    }
    const compressionMethod = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const nameStart = p + 46;
    if (nameStart + nameLen > buf.length) {
      return { ok: false, entries, error: `central directory entry ${i} name runs past the end of the file` };
    }
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    entries.push({ name, compressedSize, uncompressedSize, compressionMethod, localHeaderOffset });
    p = nameStart + nameLen + extraLen + commentLen;
  }
  return { ok: true, entries };
}

function localDataOffset(buf: Buffer, entry: ZipEntry): number | null {
  const p = entry.localHeaderOffset;
  if (p + 30 > buf.length) return null;
  if (buf.readUInt32LE(p) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  return p + 30 + nameLen + extraLen;
}

/** Extracts one entry by exact name, or null when absent or undecodable. */
export function readZipEntry(buf: Buffer, name: string, maxBytes = 32 * 1024 * 1024): Buffer | null {
  const parsed = readZipEntries(buf);
  if (!parsed.ok) return null;
  const entry = parsed.entries.find((e) => e.name === name);
  if (!entry) return null;
  if (entry.uncompressedSize > maxBytes) return null;
  const dataStart = localDataOffset(buf, entry);
  if (dataStart === null) return null;
  const data = buf.subarray(dataStart, dataStart + (entry.compressedSize || entry.uncompressedSize));
  try {
    if (entry.compressionMethod === 0) return data;
    if (entry.compressionMethod === 8) return inflateRawSync(data);
    return null;
  } catch {
    return null;
  }
}

export interface ApkValidation {
  valid: boolean;
  entryCount: number;
  hasManifest: boolean;
  hasDex: boolean;
  dexFiles: number;
  packageName: string | null;
  versionName: string | null;
  versionCode: string | null;
  error: string | null;
}

/**
 * Validates that a buffer is really an APK: a well-formed ZIP that contains a
 * binary AndroidManifest.xml, at least one classes*.dex, and a parseable
 * manifest. Anything short of that returns `valid: false` with the reason, so a
 * caller can never present an unrelated archive as a working APK.
 */
export function validateApkBuffer(buf: Buffer): ApkValidation {
  const empty: ApkValidation = {
    valid: false, entryCount: 0, hasManifest: false, hasDex: false,
    dexFiles: 0, packageName: null, versionName: null, versionCode: null, error: null,
  };
  if (buf.length === 0) return { ...empty, error: 'empty file' };
  const parsed = readZipEntries(buf);
  if (!parsed.ok) return { ...empty, error: parsed.error ?? 'not a zip archive' };

  const names = parsed.entries.map((e) => e.name);
  const hasManifest = names.includes('AndroidManifest.xml');
  const dex = names.filter((n) => /^classes\d*\.dex$/.test(n));
  const base: ApkValidation = {
    ...empty,
    entryCount: parsed.entries.length,
    hasManifest,
    hasDex: dex.length > 0,
    dexFiles: dex.length,
  };
  if (!hasManifest) return { ...base, error: 'AndroidManifest.xml is missing' };
  if (dex.length === 0) return { ...base, error: 'no classes*.dex entry' };

  const manifestBuf = readZipEntry(buf, 'AndroidManifest.xml');
  if (!manifestBuf) return { ...base, error: 'AndroidManifest.xml could not be read' };

  const parsedManifest = parseBinaryManifest(manifestBuf);
  if (!parsedManifest) {
    return { ...base, error: 'AndroidManifest.xml is present but could not be decoded' };
  }
  return {
    ...base,
    valid: true,
    packageName: parsedManifest.packageName,
    versionName: parsedManifest.versionName,
    versionCode: parsedManifest.versionCode === null ? null : String(parsedManifest.versionCode),
    error: null,
  };
}
