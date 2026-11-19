// Packfile read/write (git pack format, version 2).
//
// Read: verify header + SHA-1 trailer, inflate entries, resolve
// OFS_DELTA and REF_DELTA (including thin packs whose base lives in the
// supplied `have` map), apply delta ops, verify sizes.
// Write: plain objects only (no deltas), trailer = SHA-1 of all
// preceding bytes. Node standard library only (node:crypto, node:zlib).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjType } from './types.ts';
import { hashObject } from './git-core.ts';

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** Read a pack entry's type/size varint at `start` (bounded by `limit`). */
function readSizeVarint(buf: Buffer, start: number, limit: number): { size: number; typeCode: number; next: number } {
  if (start >= limit) throw new Error('pack entry has no size header');
  let byte = buf[start];
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while ((byte & 0x80) !== 0) {
    if (offset >= limit) throw new Error('pack entry size varint is truncated');
    byte = buf[offset];
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, typeCode, next: offset };
}

/** Read an OFS_DELTA negative-offset varint at `start`; returns the offset distance. */
function readOfsDeltaOffset(buf: Buffer, start: number, limit: number): { distance: number; next: number } {
  if (start >= limit) throw new Error('ofs-delta has no base offset');
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (offset >= limit) throw new Error('ofs-delta base offset is truncated');
    byte = buf[offset];
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { distance: value, next: offset };
}

/** Inflate one zlib stream starting at `offset` (bounded by `limit`). */
function inflateAt(buf: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, limit);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${err instanceof Error ? err.message : String(err)}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0 || offset + consumed > limit) {
    throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  }
  return { data: result.buffer, next: offset + consumed };
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA. A REF_DELTA base may live in the pack or in
 * `have` (thin packs); it is an error when it is in neither. The 20-byte
 * SHA-1 trailer is verified and a mismatch throws. Returns a map of all
 * objects in the pack (oid -> {type, data}).
 */
export function readPack(buf: Buffer, have: Map<string, GitObject>): Map<string, GitObject> {
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) {
    throw new Error(`pack trailer mismatch: expected ${computedTrailer}, got ${trailer}`);
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readSizeVarint(buf, offset, trailerStart);
    offset = header.next;
    const entry: RawEntry = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsDeltaOffset(buf, offset, trailerStart);
      offset = base.next;
      if (base.distance <= 0 || base.distance > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.distance}`);
      }
      entry.baseOffset = entryOffset - base.distance;
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[header.typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(buf, offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    byOffset.set(entryOffset, raw.length);
    raw.push(entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const resolved = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();

  const resolve = (index: number): { type: ObjType; data: Buffer; oid: string } => {
    const cached = resolved.get(index);
    if (cached !== undefined) return cached;
    if (resolving.has(index)) throw new Error(`delta cycle at pack offset ${raw[index].offset}`);
    resolving.add(index);
    try {
      const entry = raw[index];
      let type: ObjType;
      let data: Buffer;
      if (entry.typeCode === 6) {
        const baseIndex = byOffset.get(entry.baseOffset!);
        if (baseIndex === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
        const base = resolve(baseIndex);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else if (entry.typeCode === 7) {
        const wanted = entry.baseOid!;
        // Base already resolved in this pack?
        let base: { type: ObjType; data: Buffer } | undefined;
        for (const candidate of resolved.values()) {
          if (candidate.oid === wanted) {
            base = candidate;
            break;
          }
        }
        // Base in the supplied `have` map (thin pack)?
        if (base === undefined) base = have.get(wanted);
        // Base elsewhere in the pack but not resolved yet (forward reference)?
        if (base === undefined) {
          for (let k = 0; k < raw.length; k += 1) {
            if (resolved.has(k) || resolving.has(k)) continue;
            try {
              const candidate = resolve(k);
              if (candidate.oid === wanted) {
                base = candidate;
                break;
              }
            } catch {
              // That entry may fail on its own account; keep looking.
              continue;
            }
          }
        }
        if (base === undefined) {
          throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied by the client`);
        }
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        type = CODE_TYPE[entry.typeCode];
        data = entry.data;
      }
      const oid = hashObject(type, data);
      const out = { type, data, oid };
      resolved.set(index, out);
      return out;
    } finally {
      resolving.delete(index);
    }
  };

  const objects = new Map<string, GitObject>();
  for (let index = 0; index < raw.length; index += 1) {
    const entry = resolve(index);
    if (!objects.has(entry.oid)) objects.set(entry.oid, { type: entry.type, data: entry.data });
  }
  return objects;
}

/** Encode one object's pack header: the type/size varint. */
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas): header PACK + version 2
 * + count, each object as type/size varint + deflateSync(data), trailer
 * SHA-1 of everything before it.
 */
export function writePack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
