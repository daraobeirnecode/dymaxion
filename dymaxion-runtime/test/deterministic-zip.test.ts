import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDeterministicZip } from '../src/capabilities/deterministic-zip.js';

const UTF8_FLAG = 0x0800;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 33;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 0x0314;
const STORE_METHOD = 0;
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function crc32Independent(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type ParsedLocal = {
  name: string;
  offset: number;
  dataOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  flags: number;
  method: number;
  time: number;
  date: number;
  versionNeeded: number;
  bytes: Uint8Array;
};

type ParsedCentral = Omit<ParsedLocal, 'dataOffset' | 'bytes'> & {
  versionMadeBy: number;
  externalAttrs: number;
  localOffset: number;
};

function parseZip(bytes: Uint8Array): { locals: ParsedLocal[]; centrals: ParsedCentral[]; eocd: Record<string, number> } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const locals: ParsedLocal[] = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const versionNeeded = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const time = view.getUint16(offset + 10, true);
    const date = view.getUint16(offset + 12, true);
    const crc32 = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString('utf8');
    const dataOffset = nameStart + nameLength + extraLength;
    const fileBytes = bytes.subarray(dataOffset, dataOffset + compressedSize);
    locals.push({ name, offset, dataOffset, compressedSize, uncompressedSize, crc32, flags, method, time, date, versionNeeded, bytes: fileBytes });
    offset = dataOffset + compressedSize;
  }

  const centralDirectoryOffset = offset;
  const centrals: ParsedCentral[] = [];
  while (view.getUint32(offset, true) === 0x02014b50) {
    const versionMadeBy = view.getUint16(offset + 4, true);
    const versionNeeded = view.getUint16(offset + 6, true);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const time = view.getUint16(offset + 12, true);
    const date = view.getUint16(offset + 14, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttrs = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const name = Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString('utf8');
    centrals.push({ name, offset, compressedSize, uncompressedSize, crc32, flags, method, time, date, versionNeeded, versionMadeBy, externalAttrs, localOffset });
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  assert.equal(view.getUint32(offset, true), 0x06054b50);
  const eocd = {
    disk: view.getUint16(offset + 4, true),
    centralDisk: view.getUint16(offset + 6, true),
    diskEntries: view.getUint16(offset + 8, true),
    totalEntries: view.getUint16(offset + 10, true),
    centralDirectorySize: view.getUint32(offset + 12, true),
    centralDirectoryOffset: view.getUint32(offset + 16, true),
    commentLength: view.getUint16(offset + 20, true),
    offset,
  };
  assert.equal(offset + 22, bytes.byteLength);
  assert.equal(eocd.centralDirectoryOffset, centralDirectoryOffset);
  assert.equal(eocd.centralDirectorySize, eocd.offset - centralDirectoryOffset);
  return { locals, centrals, eocd };
}

test('writes byte-identical deterministic ZIP32 STORE entries in caller-supplied order with fixed metadata', () => {
  const entries = [
    { name: 'reports/alpha.json', bytes: Buffer.from('{"ok":true}\n', 'utf8') },
    { name: 'evidence/beta.txt', bytes: new Uint8Array([0, 1, 2, 3, 255]) },
  ];

  const first = createDeterministicZip(entries);
  const second = createDeterministicZip(entries.map((entry) => ({ name: entry.name, bytes: new Uint8Array(entry.bytes) })));

  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.sha256, sha256(first.bytes));
  assert.deepEqual(first.entries.map((entry) => entry.name), ['reports/alpha.json', 'evidence/beta.txt']);

  const parsed = parseZip(first.bytes);
  assert.equal(parsed.locals.length, 2);
  assert.equal(parsed.centrals.length, 2);
  assert.equal(parsed.eocd.disk, 0);
  assert.equal(parsed.eocd.centralDisk, 0);
  assert.equal(parsed.eocd.diskEntries, 2);
  assert.equal(parsed.eocd.totalEntries, 2);
  assert.equal(parsed.eocd.commentLength, 0);

  for (const [index, input] of entries.entries()) {
    const local = parsed.locals[index];
    const central = parsed.centrals[index];
    assert.ok(local);
    assert.ok(central);
    assert.equal(local.name, input.name);
    assert.equal(central.name, input.name);
    assert.equal(central.localOffset, local.offset);
    assert.equal(local.versionNeeded, VERSION_NEEDED);
    assert.equal(central.versionNeeded, VERSION_NEEDED);
    assert.equal(central.versionMadeBy, VERSION_MADE_BY);
    assert.equal(local.flags, UTF8_FLAG);
    assert.equal(central.flags, UTF8_FLAG);
    assert.equal(local.method, STORE_METHOD);
    assert.equal(central.method, STORE_METHOD);
    assert.equal(local.time, FIXED_DOS_TIME);
    assert.equal(central.time, FIXED_DOS_TIME);
    assert.equal(local.date, FIXED_DOS_DATE);
    assert.equal(central.date, FIXED_DOS_DATE);
    assert.equal(central.externalAttrs, EXTERNAL_ATTRS);
    assert.equal(local.compressedSize, input.bytes.byteLength);
    assert.equal(local.uncompressedSize, input.bytes.byteLength);
    assert.equal(central.compressedSize, input.bytes.byteLength);
    assert.equal(central.uncompressedSize, input.bytes.byteLength);
    assert.deepEqual([...local.bytes], [...input.bytes]);
    assert.equal(local.crc32, crc32Independent(input.bytes));
    assert.equal(central.crc32, crc32Independent(input.bytes));
    assert.equal(first.entries[index]?.bytes, input.bytes.byteLength);
    assert.equal(first.entries[index]?.sha256, sha256(input.bytes));
    assert.equal(first.entries[index]?.crc32, crc32Independent(input.bytes));
  }
});

test('canonical fixture archive hash remains stable', () => {
  const result = createDeterministicZip([
    {
      name: 'fixture.txt',
      bytes: Buffer.from('Dymaxion deterministic ZIP fixture\n', 'utf8'),
    },
  ]);
  assert.equal(result.sha256, '2d23d5ee4720878eee11d211e06ba0ffc788c1d876b8ce908bad20382dd59a42');
});

test('rejects unsafe names, duplicates, count ceilings and byte ceilings before writing', () => {
  const safe = (name: string, bytes = new Uint8Array([1])) => ({ name, bytes });
  for (const badName of [
    '',
    '/absolute.txt',
    'C:drive.txt',
    'dir\\file.txt',
    '../escape.txt',
    'dir/../escape.txt',
    './dot.txt',
    'dir/./dot.txt',
    'dir//empty.txt',
    'dir/',
    'évidence.txt',
    'control\n.txt',
    'space name.txt',
  ]) {
    assert.throws(() => createDeterministicZip([safe(badName)]), /invalid zip entry/i, badName);
  }

  assert.throws(() => createDeterministicZip([]), /zip entry count/i);
  assert.throws(() => createDeterministicZip([safe('a.txt'), safe('a.txt')]), /duplicate zip entry/i);
  assert.throws(() => createDeterministicZip([safe(`${'a'.repeat(256)}.txt`)]), /invalid zip entry/i);
  assert.throws(
    () => createDeterministicZip([safe('a.txt'), safe('b.txt'), safe('c.txt'), safe('d.txt'), safe('e.txt')]),
    /zip entry count/i,
  );
  assert.throws(() => createDeterministicZip([safe('big.bin', new Uint8Array(2 * 1024 * 1024 + 1))]), /zip entry bytes/i);
  assert.throws(
    () =>
      createDeterministicZip([
        safe('a.bin', new Uint8Array(1536 * 1024)),
        safe('b.bin', new Uint8Array(1536 * 1024)),
        safe('c.bin', new Uint8Array(1536 * 1024)),
      ]),
    /total zip input/i,
  );
});
