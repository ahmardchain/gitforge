// Small HTTP helpers shared by every surface: JSON replies, body reading
// and request ids. Every reply the forge sends is JSON, never HTML.

import type { IncomingMessage, ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

/** A unique, non-empty request id for X-GitHub-Request-Id. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `gitforge-${requestCounter}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** A JSON error body `{message}`. */
export function sendError(res: ServerResponse, status: number, message: string, headers: Readonly<Record<string, string>> = {}): void {
  sendJson(res, status, { message }, headers);
}

/** Read the whole request body, or reject when it is over the cap. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        done = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err: Error) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

export interface JsonBody {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Read and JSON-parse a request body. An empty body parses as null;
 * malformed JSON reports ok:false. */
export async function readJsonBody(req: IncomingMessage): Promise<JsonBody> {
  try {
    const buf = await readBody(req);
    if (buf.length === 0) return { ok: true, value: null };
    try {
      return { ok: true, value: JSON.parse(buf.toString('utf8')) };
    } catch {
      return { ok: false, error: 'malformed JSON body' };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unreadable body' };
  }
}

/** The path of a request URL, or '/' when it does not parse. */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query string of a request URL as URLSearchParams. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Split a path into its non-empty segments, percent-decoded. */
export function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

/** The bearer token of a request, or null when absent. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1] : null;
}
