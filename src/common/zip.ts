// Minimal, dependency-free ZIP support for the organization backup.
//
// Rationale: a backup must be one downloadable file, but the browser cannot create a ZIP without a
// library. The writer therefore stores entries uncompressed (the payload is JSON, and page content
// is already gzip+base64, so compression adds little) - that keeps this file small and auditable.
// The reader also accepts deflated entries (via DecompressionStream) so a re-zipped backup still
// imports. Zip64 is not supported (a backup is far below 4 GiB).

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** The stored (no compression) entry method. */
const METHOD_STORE = 0;
/** The deflate entry method (read-only support here). */
const METHOD_DEFLATE = 8;

// CRC-32 (IEEE 802.3) lookup table, built once. ZIP requires each entry's CRC.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

/** CRC-32 of a byte array (used for ZIP entry checksums). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encodes a date as the MS-DOS date/time pair ZIP stores (local time, 2-second resolution). */
function dosDateTime(now: Date): { time: number; date: number } {
  const time =
    ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
  const date =
    (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);
  return { time, date };
}

/** Concatenates byte arrays into one. */
function joinBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}

/** Builds a ZIP archive (stored entries) from the given files. */
export function writeZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  entries.forEach((entry) => {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);

    // Local file header (30 bytes) + name + data.
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed to extract
    localView.setUint16(6, 0x0800, true); // names are UTF-8
    localView.setUint16(8, METHOD_STORE, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.data.length, true); // compressed size
    localView.setUint32(22, entry.data.length, true); // uncompressed size
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true); // extra length
    local.set(name, 30);
    parts.push(local, entry.data);

    // Central directory record (46 bytes) + name.
    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(4, 20, true); // version made by
    recordView.setUint16(6, 20, true); // version needed
    recordView.setUint16(8, 0x0800, true);
    recordView.setUint16(10, METHOD_STORE, true);
    recordView.setUint16(12, time, true);
    recordView.setUint16(14, date, true);
    recordView.setUint32(16, crc, true);
    recordView.setUint32(20, entry.data.length, true);
    recordView.setUint32(24, entry.data.length, true);
    recordView.setUint16(28, name.length, true);
    recordView.setUint16(30, 0, true); // extra length
    recordView.setUint16(32, 0, true); // comment length
    recordView.setUint16(34, 0, true); // disk number start
    recordView.setUint16(36, 0, true); // internal attributes
    recordView.setUint32(38, 0, true); // external attributes
    recordView.setUint32(42, offset, true); // local header offset
    record.set(name, 46);
    central.push(record);

    offset += local.length + entry.data.length;
  });

  const centralSize = central.reduce((sum, record) => sum + record.length, 0);

  // End of central directory (22 bytes); comment is empty.
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return joinBytes([...parts, ...central, end]);
}

/** Reads a ZIP archive into a name -> bytes map; throws when the archive cannot be parsed. */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  if (endOffset < 0) {
    throw new Error("Not a ZIP file (no end-of-central-directory record was found).");
  }
  const count = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map<string, Uint8Array>();

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      break;
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    // The central directory is authoritative for sizes, so data descriptors (flag bit 3) are fine.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === METHOD_STORE) {
      entries.set(name, raw.slice());
    } else if (method === METHOD_DEFLATE) {
      entries.set(name, await inflateRaw(raw));
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    }
  }
  return entries;
}

/** Scans backwards for the end-of-central-directory signature (it follows a variable comment). */
function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 22 - 65535);
  for (let i = view.byteLength - 22; i >= minimum; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      return i;
    }
  }
  return -1;
}

/** Inflates a raw-deflate entry (used only when a backup was re-zipped with compression). */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress the backup (no DecompressionStream support).");
  }
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
