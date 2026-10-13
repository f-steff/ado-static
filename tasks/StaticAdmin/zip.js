// ZIP read/write for the StaticAdmin task.
//
// Rationale: a backup has to be one portable file, and a pipeline task may not depend on any npm
// package (the shipped folder must stay tiny), so this is a small in-house ZIP codec. Entries are
// written with raw deflate (Node's zlib) - page content is already gzip+base64, so the extra
// compression is cheap and keeps artifacts small. The reader also accepts *stored* entries, so an
// archive produced by the browser UI (which stores entries uncompressed) restores here too. Zip64 is
// not supported (a backup is far below 4 GiB).
const zlib = require("zlib");

// ZIP compression methods: 0 = stored, 8 = raw deflate.
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// CRC-32 (IEEE 802.3) lookup table, built once; ZIP requires each entry's checksum.
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let value = n;
        for (let bit = 0; bit < 8; bit += 1) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[n] = value;
    }
    return table;
})();

/** CRC-32 of a buffer, as an unsigned 32-bit number. */
function crc32(buffer) {
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i += 1) {
        crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** Encodes a date as the MS-DOS date/time pair ZIP stores (local time, 2-second resolution). */
function dosDateTime(now) {
    const time =
        ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
    const date =
        (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);
    return { time, date };
}

/** Scans backwards for the end-of-central-directory signature (it follows a variable comment). */
function findEndOfCentralDirectory(buffer) {
    const minimum = Math.max(0, buffer.length - 22 - 65535);
    for (let i = buffer.length - 22; i >= minimum; i -= 1) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
            return i;
        }
    }
    return -1;
}

/**
 * Builds a ZIP archive from `[{ name, data }]`.
 * Each entry is deflated when that is smaller, otherwise stored, so incompressible payloads do not
 * grow; CRCs always cover the uncompressed bytes.
 */
function writeZip(entries, now = new Date()) {
    const { time, date } = dosDateTime(now);
    const parts = [];
    const central = [];
    let offset = 0;

    entries.forEach((entry) => {
        const name = Buffer.from(entry.name, "utf8");
        const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
        const deflated = zlib.deflateRawSync(raw);
        const useDeflate = deflated.length < raw.length;
        const payload = useDeflate ? deflated : raw;
        const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
        const checksum = crc32(raw);

        // Local file header (30 bytes) + name + payload.
        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed to extract
        local.writeUInt16LE(0x0800, 6); // names are UTF-8
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(payload.length, 18); // compressed size
        local.writeUInt32LE(raw.length, 22); // uncompressed size
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28); // extra length
        name.copy(local, 30);
        parts.push(local, payload);

        // Central directory record (46 bytes) + name.
        const record = Buffer.alloc(46 + name.length);
        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt16LE(20, 4); // version made by
        record.writeUInt16LE(20, 6); // version needed
        record.writeUInt16LE(0x0800, 8);
        record.writeUInt16LE(method, 10);
        record.writeUInt16LE(time, 12);
        record.writeUInt16LE(date, 14);
        record.writeUInt32LE(checksum, 16);
        record.writeUInt32LE(payload.length, 20);
        record.writeUInt32LE(raw.length, 24);
        record.writeUInt16LE(name.length, 28);
        record.writeUInt16LE(0, 30); // extra length
        record.writeUInt16LE(0, 32); // comment length
        record.writeUInt16LE(0, 34); // disk number start
        record.writeUInt16LE(0, 36); // internal attributes
        record.writeUInt32LE(0, 38); // external attributes
        record.writeUInt32LE(offset, 42); // local header offset
        name.copy(record, 46);
        central.push(record);

        offset += local.length + payload.length;
    });

    const centralBuffer = Buffer.concat(central);

    // End of central directory (22 bytes); the comment is empty.
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...parts, centralBuffer, end]);
}

/** Reads a ZIP archive into a name -> Buffer map; throws when the archive cannot be parsed. */
function readZip(buffer) {
    const endOffset = findEndOfCentralDirectory(buffer);
    if (endOffset < 0) {
        throw new Error("Not a ZIP file (no end-of-central-directory record was found).");
    }
    const count = buffer.readUInt16LE(endOffset + 10);
    let offset = buffer.readUInt32LE(endOffset + 16);
    const entries = new Map();

    for (let i = 0; i < count; i += 1) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
            break;
        }
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
        offset += 46 + nameLength + extraLength + commentLength;

        // The central directory is authoritative for sizes, so data descriptors (flag bit 3) are fine.
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const raw = buffer.subarray(dataStart, dataStart + compressedSize);
        if (method === METHOD_STORE) {
            entries.set(name, Buffer.from(raw));
        } else if (method === METHOD_DEFLATE) {
            entries.set(name, zlib.inflateRawSync(raw));
        } else {
            throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
        }
    }
    return entries;
}

module.exports = { crc32, readZip, writeZip };
