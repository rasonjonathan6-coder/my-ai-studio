/**
 * A minimal ZIP writer.
 *
 * The export must not depend on a system `zip` binary: it is missing from
 * slim container images, and its failure mode is a silent 500 for the user.
 * This writes a real, spec-conformant archive - local headers, a central
 * directory and an end-of-central-directory record - using only Node built-ins.
 *
 * Entries are streamed in and compressed with raw deflate. File names are
 * UTF-8 with the language-encoding flag set, and the DOS timestamp is derived
 * from the file's mtime so the archive reflects when the files were last
 * modified rather than when it was created.
 */
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.ts';

export interface ZipSourceEntry {
  /** Forward-slash separated path inside the archive. */
  name: string;
  content: Buffer;
  mtime?: Date;
  /** Keep the entry uncompressed; used for already-compressed payloads. */
  store?: boolean;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
const VERSION = 20;
// Bit 3 is deliberately left clear: sizes and CRCs are known up front because
// every entry is compressed in memory before its header is written.
const FLAG_UTF8 = 0x0800;

function dosDateTime(date: Date): { date: number; time: number } {
  const year = date.getFullYear();
  // DOS timestamps cannot represent anything before 1980; clamp instead of
  // producing a negative bitfield.
  const clamped = year < 1980 ? new Date(1980, 0, 1) : date;
  const dosDate = ((clamped.getFullYear() - 1980) << 9) | ((clamped.getMonth() + 1) << 5) | clamped.getDate();
  const dosTime = (clamped.getHours() << 11) | (clamped.getMinutes() << 5) | Math.floor(clamped.getSeconds() / 2);
  return { date: dosDate, time: dosTime };
}

export interface ZipWriteResult {
  buffer: Buffer;
  entryCount: number;
  /** Uncompressed total, for reporting compression ratio. */
  rawBytes: number;
}

export function writeZip(entries: ZipSourceEntry[]): ZipWriteResult {
  if (entries.length > 0xffff) {
    throw new Error('writeZip: more than 65535 entries requires ZIP64, which is not implemented');
  }

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let rawBytes = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.store ? 0 : 8;
    const body = entry.store ? entry.content : deflateRawSync(entry.content, { level: 9 });
    const crc = crc32(entry.content);
    rawBytes += entry.content.length;

    const { date, time } = dosDateTime(entry.mtime ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // no extra field

    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(VERSION, 4); // version made by
    central.writeUInt16LE(VERSION, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    // Bit 0 of the external attributes marks read-only; 0644 with the DOS
    // directory bit clear keeps the entry a plain file.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_RECORD, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  end.writeUInt16LE(0, 20); // comment length

  return {
    buffer: Buffer.concat([localBuf, centralBuf, end]),
    entryCount: entries.length,
    rawBytes,
  };
}
