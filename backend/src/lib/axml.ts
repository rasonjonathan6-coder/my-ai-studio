/**
 * Binary AndroidManifest.xml (AXML) parser.
 *
 * The manifest inside an APK is not plain XML: aapt2 compiles it into the
 * chunked binary format the framework reads at runtime. Parsing it directly
 * means the APK can be inspected correctly without the Android SDK installed,
 * instead of guessing from printable strings in the file - a guess that happily
 * returns "android.intent.action.MAIN" as a package name.
 *
 * Only the manifest structure is decoded; the format is stable and documented
 * by the AOSP `ResChunk_header` / `ResXMLTree_*` definitions.
 */

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_CDATA_TYPE = 0x0104;

const UTF8_FLAG = 0x00000100;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

export const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

/**
 * Framework attribute names, keyed by resource id. AAPT2 blanks the string
 * pool entry for framework attributes and refers to them by resource id
 * instead, so the name has to come from this table.
 */
const ATTR_NAMES: Record<number, string> = {
  0x01010000: 'theme',
  0x01010001: 'label',
  0x01010002: 'icon',
  0x01010003: 'name',
  0x01010004: 'manageSpaceActivity',
  0x01010005: 'allowClearUserData',
  0x01010006: 'permission',
  0x01010007: 'readPermission',
  0x01010008: 'writePermission',
  0x0101000e: 'permissionGroup',
  0x0101000f: 'debuggable',
  0x01010010: 'exported',
  0x01010011: 'process',
  0x01010012: 'taskAffinity',
  0x01010018: 'authorities',
  0x0101001d: 'enabled',
  0x0101020c: 'minSdkVersion',
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
  0x01010270: 'targetSdkVersion',
  0x0101048b: 'usesCleartextTraffic',
};

export interface AxmlAttribute {
  namespace: string | null;
  name: string;
  value: string | number | boolean | null;
}

export interface AxmlElement {
  name: string;
  namespace: string | null;
  attributes: AxmlAttribute[];
  children: AxmlElement[];
}

interface StringPool {
  strings: string[];
}

function readUInt16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}

function readUInt32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

/** Reads a ULEB128 value, used for string pool lengths. */
function readUleb128(buf: Buffer, off: number): { value: number; bytes: number } {
  let value = 0;
  let shift = 0;
  let bytes = 0;
  for (;;) {
    const byte = buf[off + bytes];
    if (byte === undefined) break;
    bytes += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, bytes };
}

function parseStringPool(buf: Buffer, chunkStart: number): StringPool {
  const headerSize = readUInt16(buf, chunkStart + 2);
  const chunkSize = readUInt32(buf, chunkStart + 4);
  const stringCount = readUInt32(buf, chunkStart + 8);
  const flags = readUInt32(buf, chunkStart + 16);
  const stringsStart = readUInt32(buf, chunkStart + 20);
  const isUtf8 = (flags & UTF8_FLAG) !== 0;

  const strings: string[] = [];
  const offsetsStart = chunkStart + headerSize;
  const dataStart = chunkStart + stringsStart;
  const dataEnd = chunkStart + chunkSize;

  for (let i = 0; i < stringCount; i += 1) {
    const offsetPos = offsetsStart + i * 4;
    if (offsetPos + 4 > buf.length) break;
    const strOff = dataStart + readUInt32(buf, offsetPos);
    if (strOff >= dataEnd || strOff >= buf.length) {
      strings.push('');
      continue;
    }

    if (isUtf8) {
      // Length in characters, then length in bytes; either may be 0x80-escaped.
      let cursor = strOff;
      const charLen = readUleb128(buf, cursor);
      cursor += charLen.bytes;
      const byteLen = readUleb128(buf, cursor);
      cursor += byteLen.bytes;
      strings.push(buf.toString('utf8', cursor, Math.min(cursor + byteLen.value, buf.length)));
    } else {
      // UTF-16 pools use a plain uint16 character count, unlike the UTF-8
      // pools where both lengths are ULEB128.
      const charLen = readUInt16(buf, strOff);
      const start = strOff + 2;
      strings.push(buf.toString('utf16le', start, Math.min(start + charLen * 2, buf.length)));
    }
  }

  return { strings };
}

/** Walks the chunk list, invoking onChunk for every top-level chunk. */
function eachChunk(buf: Buffer, onChunk: (type: number, start: number, size: number) => void): void {
  let offset = readUInt16(buf, 2); // size of the file header chunk
  while (offset + 8 <= buf.length) {
    const type = readUInt16(buf, offset);
    const chunkSize = readUInt32(buf, offset + 4);
    if (chunkSize < 8 || offset + chunkSize > buf.length) break;
    onChunk(type, offset, chunkSize);
    offset += chunkSize;
  }
}

function attributeName(pool: StringPool, resourceMap: number[], nameIndex: number): string {
  const fromPool = pool.strings[nameIndex];
  if (fromPool) return fromPool;
  const resId = resourceMap[nameIndex];
  if (resId === undefined) return `attr@${nameIndex}`;
  return ATTR_NAMES[resId] ?? `0x${resId.toString(16).padStart(8, '0')}`;
}

function decodeValue(pool: StringPool, rawValue: number, dataType: number, data: number): string | number | boolean | null {
  if (rawValue !== 0xffffffff) {
    const raw = pool.strings[rawValue];
    if (raw !== undefined) return raw;
  }
  switch (dataType) {
    case TYPE_STRING:
      return pool.strings[data] ?? null;
    case TYPE_INT_BOOLEAN:
      return data !== 0;
    case TYPE_INT_DEC:
      return data;
    case TYPE_INT_HEX:
      return `0x${(data >>> 0).toString(16)}`;
    case TYPE_REFERENCE:
      return `@0x${(data >>> 0).toString(16)}`;
    default:
      return data;
  }
}

export interface ParsedManifest {
  packageName: string | null;
  versionName: string | null;
  versionCode: number | null;
  minSdk: number | null;
  targetSdk: number | null;
  debuggable: boolean | null;
  cleartextTraffic: boolean | null;
  permissions: string[];
  activities: string[];
  services: string[];
  receivers: string[];
  providers: string[];
  /** Activity that is the launcher entry point, when one is declared. */
  mainActivity: string | null;
}

function attrValue(el: AxmlElement, name: string): string | number | boolean | null {
  const attr = el.attributes.find((a) => a.name === name);
  return attr ? attr.value : null;
}

function asString(value: string | number | boolean | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asInt(value: string | number | boolean | null): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * Parses a binary AndroidManifest.xml and extracts the fields an APK
 * inspection needs. Returns null when the buffer is not a valid AXML document,
 * so callers can report "unknown" rather than inventing a value.
 */
export function parseBinaryManifest(buf: Buffer): ParsedManifest | null {
  if (buf.length < 8) return null;
  if (readUInt16(buf, 0) !== RES_XML_TYPE) return null;

  let pool: StringPool = { strings: [] };
  const resourceMap: number[] = [];
  let root: AxmlElement | null = null;
  const stack: AxmlElement[] = [];

  eachChunk(buf, (type, start) => {
    if (type === RES_STRING_POOL_TYPE) {
      pool = parseStringPool(buf, start);
      return;
    }
    if (type === RES_XML_RESOURCE_MAP_TYPE) {
      const headerSize = readUInt16(buf, start + 2);
      const chunkSize = readUInt32(buf, start + 4);
      for (let off = start + headerSize; off + 4 <= start + chunkSize; off += 4) {
        resourceMap.push(readUInt32(buf, off));
      }
      return;
    }
    if (type !== RES_XML_START_ELEMENT_TYPE && type !== RES_XML_END_ELEMENT_TYPE) {
      if (type === RES_XML_CDATA_TYPE && stack.length > 0) {
        // Text content is not needed for manifest inspection.
      }
      if (type === RES_XML_START_NAMESPACE_TYPE || type === RES_XML_END_NAMESPACE_TYPE) return;
      return;
    }

    if (type === RES_XML_END_ELEMENT_TYPE) {
      stack.pop();
      return;
    }

    const nsIndex = readUInt32(buf, start + 16);
    const nameIndex = readUInt32(buf, start + 20);
    const attributeStart = readUInt16(buf, start + 24);
    const attributeSize = readUInt16(buf, start + 26);
    const attributeCount = readUInt16(buf, start + 28);

    const element: AxmlElement = {
      name: pool.strings[nameIndex] ?? `element@${nameIndex}`,
      namespace: pool.strings[nsIndex] ?? null,
      attributes: [],
      children: [],
    };

    const attrsBase = start + 16 + attributeStart;
    for (let i = 0; i < attributeCount; i += 1) {
      const attrOff = attrsBase + i * attributeSize;
      if (attrOff + 20 > buf.length) break;
      const attrNsIndex = readUInt32(buf, attrOff);
      const attrNameIndex = readUInt32(buf, attrOff + 4);
      const rawValue = readUInt32(buf, attrOff + 8);
      const dataType = buf[attrOff + 15];
      const data = readUInt32(buf, attrOff + 16);

      element.attributes.push({
        namespace: pool.strings[attrNsIndex] ?? null,
        name: attributeName(pool, resourceMap, attrNameIndex),
        value: decodeValue(pool, rawValue, dataType, data),
      });
    }

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (!root) root = element;
    stack.push(element);
  });

  if (!root) return null;
  const manifestEl: AxmlElement = root;

  // Attribute lookups prefer the android namespace, then fall back to a bare
  // name, because tools vary in whether they emit the namespace prefix.
  const pick = (el: AxmlElement, name: string): string | number | boolean | null => {
    const scoped = el.attributes.find((a) => a.name === name && a.namespace === ANDROID_NS);
    return scoped ? scoped.value : attrValue(el, name);
  };

  const application = manifestEl.children.find((c) => c.name === 'application') ?? null;
  const componentsOf = (name: string): string[] =>
    (application?.children ?? [])
      .filter((c) => c.name === name)
      .map((c) => asString(pick(c, 'name')))
      .filter((v): v is string => v !== null);

  const mainActivity =
    (application?.children ?? [])
      .filter((c) => c.name === 'activity')
      .find((activity) =>
        activity.children.some(
          (child) =>
            child.name === 'intent-filter' &&
            child.children.some((c) => c.name === 'action' && pick(c, 'name') === 'android.intent.action.MAIN'),
        ),
      ) ?? null;

  const appAttr = (name: string): string | number | boolean | null =>
    application ? pick(application, name) : null;
  const boolOf = (value: string | number | boolean | null): boolean | null =>
    typeof value === 'boolean' ? value : null;

  // minSdkVersion / targetSdkVersion live on <uses-sdk>. Older tooling also
  // wrote them on <application>, so both are consulted.
  const usesSdk = manifestEl.children.find((c) => c.name === 'uses-sdk') ?? null;
  const sdkAttr = (name: string): string | number | boolean | null =>
    (usesSdk ? pick(usesSdk, name) : null) ?? appAttr(name);

  return {
    packageName: asString(pick(manifestEl, 'package')),
    versionName: asString(pick(manifestEl, 'versionName')),
    versionCode: asInt(pick(manifestEl, 'versionCode')),
    minSdk: asInt(sdkAttr('minSdkVersion')),
    targetSdk: asInt(sdkAttr('targetSdkVersion')),
    debuggable: boolOf(appAttr('debuggable')),
    cleartextTraffic: boolOf(appAttr('usesCleartextTraffic')),
    permissions: manifestEl.children
      .filter((c) => c.name === 'uses-permission')
      .map((c) => asString(pick(c, 'name')))
      .filter((v): v is string => v !== null),
    activities: componentsOf('activity'),
    services: componentsOf('service'),
    receivers: componentsOf('receiver'),
    providers: componentsOf('provider'),
    mainActivity: mainActivity ? asString(pick(mainActivity, 'name')) : null,
  };
}
