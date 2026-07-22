import { createHash } from 'node:crypto';

export const MAX_DETERMINISTIC_ZIP_ENTRIES = 4;
export const MAX_DETERMINISTIC_ZIP_ENTRY_BYTES = 2 * 1024 * 1024;
export const MAX_DETERMINISTIC_ZIP_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_DETERMINISTIC_ZIP_OUTPUT_BYTES = 5 * 1024 * 1024;
export const MAX_DETERMINISTIC_ZIP_ENTRY_NAME_BYTES = 255;

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const STORE_METHOD = 0;
const UTF8_FLAG = 0x0800;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY_UNIX = 0x0314;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 33;
const REGULAR_FILE_0644_EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;
const UINT32_MAX = 0xffffffff;
const SAFE_NAME = /^[A-Za-z0-9._/-]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface DeterministicZipEntryInput {
  name: string;
  bytes: Uint8Array;
}

export interface DeterministicZipEntryMetadata {
  name: string;
  sha256: string;
  bytes: number;
  crc32: number;
}

export interface DeterministicZipResult {
  bytes: Uint8Array;
  entries: DeterministicZipEntryMetadata[];
  sha256: string;
}

interface PreparedEntry extends DeterministicZipEntryMetadata {
  data: Uint8Array;
  nameBytes: Uint8Array;
  localHeaderOffset: number;
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  CRC32_TABLE[index] = crc >>> 0;
}

function fail(message: string): never {
  throw new Error(message);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertUint32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    fail(`${label} exceeds ZIP32 bounds`);
  }
}

function validateEntryName(name: string): Uint8Array {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_DETERMINISTIC_ZIP_ENTRY_NAME_BYTES) {
    fail('invalid zip entry name');
  }
  if (CONTROL_CHARS.test(name) || !SAFE_NAME.test(name)) {
    fail('invalid zip entry name');
  }
  if (name.startsWith('/') || name.startsWith('./') || name.startsWith('../') || name.endsWith('/')) {
    fail('invalid zip entry name');
  }
  if (name.includes('\\') || name.includes(':') || name.includes('//')) {
    fail('invalid zip entry name');
  }
  const parts = name.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    fail('invalid zip entry name');
  }
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.byteLength !== name.length || nameBytes.byteLength > MAX_DETERMINISTIC_ZIP_ENTRY_NAME_BYTES) {
    fail('invalid zip entry name');
  }
  return nameBytes;
}

function writeUInt16LE(output: Uint8Array, offset: number, value: number): void {
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint16(offset, value, true);
}

function writeUInt32LE(output: Uint8Array, offset: number, value: number): void {
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(offset, value >>> 0, true);
}

function writeLocalHeader(output: Uint8Array, offset: number, entry: PreparedEntry): number {
  writeUInt32LE(output, offset, LOCAL_FILE_HEADER_SIGNATURE);
  writeUInt16LE(output, offset + 4, VERSION_NEEDED);
  writeUInt16LE(output, offset + 6, UTF8_FLAG);
  writeUInt16LE(output, offset + 8, STORE_METHOD);
  writeUInt16LE(output, offset + 10, FIXED_DOS_TIME);
  writeUInt16LE(output, offset + 12, FIXED_DOS_DATE);
  writeUInt32LE(output, offset + 14, entry.crc32);
  writeUInt32LE(output, offset + 18, entry.bytes);
  writeUInt32LE(output, offset + 22, entry.bytes);
  writeUInt16LE(output, offset + 26, entry.nameBytes.byteLength);
  writeUInt16LE(output, offset + 28, 0);
  output.set(entry.nameBytes, offset + 30);
  output.set(entry.data, offset + 30 + entry.nameBytes.byteLength);
  return offset + 30 + entry.nameBytes.byteLength + entry.bytes;
}

function writeCentralDirectoryHeader(output: Uint8Array, offset: number, entry: PreparedEntry): number {
  writeUInt32LE(output, offset, CENTRAL_DIRECTORY_SIGNATURE);
  writeUInt16LE(output, offset + 4, VERSION_MADE_BY_UNIX);
  writeUInt16LE(output, offset + 6, VERSION_NEEDED);
  writeUInt16LE(output, offset + 8, UTF8_FLAG);
  writeUInt16LE(output, offset + 10, STORE_METHOD);
  writeUInt16LE(output, offset + 12, FIXED_DOS_TIME);
  writeUInt16LE(output, offset + 14, FIXED_DOS_DATE);
  writeUInt32LE(output, offset + 16, entry.crc32);
  writeUInt32LE(output, offset + 20, entry.bytes);
  writeUInt32LE(output, offset + 24, entry.bytes);
  writeUInt16LE(output, offset + 28, entry.nameBytes.byteLength);
  writeUInt16LE(output, offset + 30, 0);
  writeUInt16LE(output, offset + 32, 0);
  writeUInt16LE(output, offset + 34, 0);
  writeUInt16LE(output, offset + 36, 0);
  writeUInt32LE(output, offset + 38, REGULAR_FILE_0644_EXTERNAL_ATTRS);
  writeUInt32LE(output, offset + 42, entry.localHeaderOffset);
  output.set(entry.nameBytes, offset + 46);
  return offset + 46 + entry.nameBytes.byteLength;
}

function writeEocd(output: Uint8Array, offset: number, entryCount: number, centralSize: number, centralOffset: number): number {
  writeUInt32LE(output, offset, EOCD_SIGNATURE);
  writeUInt16LE(output, offset + 4, 0);
  writeUInt16LE(output, offset + 6, 0);
  writeUInt16LE(output, offset + 8, entryCount);
  writeUInt16LE(output, offset + 10, entryCount);
  writeUInt32LE(output, offset + 12, centralSize);
  writeUInt32LE(output, offset + 16, centralOffset);
  writeUInt16LE(output, offset + 20, 0);
  return offset + 22;
}

export function createDeterministicZip(entries: readonly DeterministicZipEntryInput[]): DeterministicZipResult {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_DETERMINISTIC_ZIP_ENTRIES) {
    fail('zip entry count is outside the supported range');
  }

  const names = new Set<string>();
  const prepared: PreparedEntry[] = [];
  let totalInputBytes = 0;
  let outputBytes = 22;

  for (const entry of entries) {
    const nameBytes = validateEntryName(entry.name);
    if (names.has(entry.name)) {
      fail('duplicate zip entry name');
    }
    names.add(entry.name);
    if (!(entry.bytes instanceof Uint8Array)) {
      fail('invalid zip entry bytes');
    }
    const data = new Uint8Array(entry.bytes.byteLength);
    data.set(entry.bytes);
    if (data.byteLength > MAX_DETERMINISTIC_ZIP_ENTRY_BYTES) {
      fail('zip entry bytes exceed the supported ceiling');
    }
    totalInputBytes += data.byteLength;
    if (totalInputBytes > MAX_DETERMINISTIC_ZIP_INPUT_BYTES) {
      fail('total zip input bytes exceed the supported ceiling');
    }
    const localBytes = 30 + nameBytes.byteLength + data.byteLength;
    const centralBytes = 46 + nameBytes.byteLength;
    assertUint32(localBytes, 'local header');
    assertUint32(centralBytes, 'central directory header');
    outputBytes += localBytes + centralBytes;
    assertUint32(outputBytes, 'zip output');
    if (outputBytes > MAX_DETERMINISTIC_ZIP_OUTPUT_BYTES) {
      fail('zip output bytes exceed the supported ceiling');
    }
    prepared.push({
      name: entry.name,
      data,
      nameBytes,
      bytes: data.byteLength,
      sha256: sha256(data),
      crc32: crc32(data),
      localHeaderOffset: 0,
    });
  }

  const output = new Uint8Array(outputBytes);
  let offset = 0;
  for (const entry of prepared) {
    entry.localHeaderOffset = offset;
    offset = writeLocalHeader(output, offset, entry);
    assertUint32(offset, 'local file offset');
  }
  const centralOffset = offset;
  for (const entry of prepared) {
    offset = writeCentralDirectoryHeader(output, offset, entry);
    assertUint32(offset, 'central directory offset');
  }
  const centralSize = offset - centralOffset;
  assertUint32(centralSize, 'central directory size');
  offset = writeEocd(output, offset, prepared.length, centralSize, centralOffset);
  if (offset !== output.byteLength) {
    fail('zip output assembly failed');
  }

  return {
    bytes: output,
    entries: prepared.map(({ name, sha256: digest, bytes, crc32: crc }) => ({ name, sha256: digest, bytes, crc32: crc })),
    sha256: sha256(output),
  };
}
