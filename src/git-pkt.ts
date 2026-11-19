// pkt-line encode/decode (git smart HTTP framing).
//
// A pkt-line is 4 hex ASCII length bytes (payload length + 4) followed by
// the payload. Length 0 is flush ("0000"), 1 is delim ("0001"), 2 is
// response-end ("0002"). The largest pkt-line including its header is
// 65520 bytes.

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type PktLine =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (payload.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${payload.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((payload.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

/** The flush packet ("0000"). */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet ("0001"). */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** The response-end packet ("0002"). */
export function pktEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Decode a complete buffer into packets. Throws on malformed or truncated lines. */
export function parsePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < 4) {
      throw new Error(`truncated pkt-line: ${buf.length - offset} trailing byte(s)`);
    }
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length === 3) {
      throw new Error('invalid pkt-line length 0003');
    }
    if (length > PKT_LINE_MAX) {
      throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    }
    if (buf.length - offset < length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${buf.length - offset} available`);
    }
    out.push({ kind: 'data', data: Buffer.from(buf.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return out;
}
