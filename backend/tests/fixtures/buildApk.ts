/**
 * Builds an in-memory APK for tests.
 *
 * The manifest is the real AAPT2-compiled fixture checked in beside it (the same
 * one axml.test.ts asserts against), so validation exercises the actual binary
 * parser. The dex member is a minimal but well-formed `classes.dex` header: it
 * exists so the presence check is exercised without shipping a real Dalvik
 * image in the repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const manifestPath = path.join(import.meta.dirname, 'AndroidManifest.bin.xml');
const MANIFEST = fs.readFileSync(manifestPath);

/** A minimal `classes.dex` with a valid magic and header fields. */
function minimalDex(): Buffer {
  const dex = Buffer.alloc(112);
  dex.write('dex\n035\0', 0, 'latin1');
  dex.writeUInt32LE(112, 0x24); // file_size
  dex.writeUInt32LE(112, 0x28); // header_size
  dex.writeUInt32LE(0x12345678, 0x08); // checksum placeholder
  return dex;
}

/**
 * Assembles `entries` into a ZIP archive. Deflate is used for compressed members
 * so the reader has to inflate rather than pass bytes through, and the central
 * directory is written last, as a real writer would.
 */
function zip(entries: Array<{ name: string; content: Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.store ? 0 : 8;
    const body = entry.store ? entry.content : deflateRawSync(entry.content);
    const crc = crc32(entry.content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

/** A structurally valid APK carrying the real compiled manifest. */
export function buildApkFixture(): Buffer {
  return zip([
    { name: 'AndroidManifest.xml', content: MANIFEST },
    { name: 'classes.dex', content: minimalDex() },
    { name: 'resources.arsc', content: Buffer.from('RES_TABLE\0') },
    { name: 'META-INF/MANIFEST.MF', content: Buffer.from('Manifest-Version: 1.0\n') },
  ]);
}

/** An APK variant with a renamed dex, to prove the pattern is not literal. */
export function buildApkWithSecondaryDex(): Buffer {
  return zip([
    { name: 'AndroidManifest.xml', content: MANIFEST },
    { name: 'classes.dex', content: minimalDex() },
    { name: 'classes2.dex', content: minimalDex() },
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export { zip as makeZipArchive };
