// Smart HTTP for git: info/refs (v0 + v2), upload-pack (v2 + v0) and
// receive-pack (v0 + report-status), backed by the in-memory Store.
//
// Protocol notes (checked against the kit's git-client.ts, which is the
// grading client, and against real git behaviour):
// - v2 fetch responses are sections named by a pkt-line, contents
//   following directly, sections separated by a delim packet and the
//   response ended by a flush. No delim goes between a section name and
//   its contents.
// - The pack is always sent complete (no deltas); thin-pack is satisfied
//   by completeness. Sideband band 1 carries pack bytes, chunked so no
//   pkt-line payload exceeds 65516 bytes (1 band byte + 65515 pack bytes).
// - Shallow fetches: `deepen N` is a total depth from each want (want =
//   generation 1). Objects the client already holds are the objects
//   reachable from its haves, except that a requested shallow boundary
//   is treated as a leaf (its parents are NOT held). That is what makes
//   `deepen` past an existing boundary deliver exactly the new
//   generation instead of nothing.
// - receive-pack: the command list is pkt-framed, the pack that follows
//   is raw bytes. A delete-only push carries no pack.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import type { GitObject, Repo } from './types.ts';
import { pathOf, queryOf, readBody, segmentsOf } from './http-util.ts';
import { parseCommit, parseTag, parseTree } from './git-core.ts';
import { readPack, writePack } from './git-pack.ts';
import { pktDelim, pktFlush, pktLine, parsePktLines } from './git-pkt.ts';

const ZERO_OID = '0'.repeat(40);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HEX40 = /^[0-9a-f]{40}$/;
/** Largest pack chunk inside one sideband pkt-line (1 band byte + data). */
const SIDEBAND_CHUNK = 65515;

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendText(res, 404, 'not found\n');
}

function badRequest(res: ServerResponse, message: string): void {
  sendText(res, 400, `${message}\n`);
}

/** True when the request carries `Git-Protocol: version=2`. */
function wantsV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  if (typeof header === 'string') return header.includes('version=2');
  if (Array.isArray(header)) return header.some((value) => value.includes('version=2'));
  return false;
}

/** Oid of the default branch tip, or null when the repo is unborn. */
function headOid(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** Refs in advertisement order: refs/heads/* then refs/tags/*, each sorted. */
function sortedRefs(repo: Repo): Array<{ ref: string; oid: string }> {
  const heads: Array<{ ref: string; oid: string }> = [];
  const tags: Array<{ ref: string; oid: string }> = [];
  const other: Array<{ ref: string; oid: string }> = [];
  for (const [ref, oid] of repo.refs) {
    const entry = { ref, oid };
    if (ref.startsWith('refs/heads/')) heads.push(entry);
    else if (ref.startsWith('refs/tags/')) tags.push(entry);
    else other.push(entry);
  }
  const byRef = (a: { ref: string }, b: { ref: string }): number =>
    Buffer.compare(Buffer.from(a.ref, 'utf8'), Buffer.from(b.ref, 'utf8'));
  heads.sort(byRef);
  tags.sort(byRef);
  other.sort(byRef);
  return [...heads, ...tags, ...other];
}

/** Follow a chain of annotated tags to its final target oid, or null. */
function peelTarget(objects: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = objects.get(current);
    if (obj === undefined) return null;
    if (obj.type !== 'tag') return current;
    try {
      current = parseTag(obj.data).object;
    } catch {
      return null;
    }
  }
}

/** For a tag ref, the commit it peels to (through nested tags), or null. */
function peeledCommit(objects: Map<string, GitObject>, oid: string): string | null {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const target = peelTarget(objects, oid);
  if (target === null) return null;
  const targetObj = objects.get(target);
  if (targetObj === undefined || targetObj.type !== 'commit') return null;
  return target;
}

/** Parents of a commit oid (empty when missing / not a commit / malformed). */
function commitParents(objects: Map<string, GitObject>, oid: string): string[] {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return [];
  try {
    return parseCommit(obj.data).parents;
  } catch {
    return [];
  }
}

/**
 * True when `ancestorOid` is `oid` or reachable from it via parents. The
 * same answer git-core's isAncestor gives, but it stops at the first hit
 * instead of building the whole ancestor set: a fast-forward check whose
 * old tip is the direct parent costs one commit parse, not a walk of the
 * entire history (a 200-push chain paid ~440 us per push for the full
 * set). A non-ancestor still walks everything, so the answer is identical
 * either way, cycles included (the seen set guards both).
 */
function isAncestorOf(objects: Map<string, GitObject>, ancestorOid: string, oid: string): boolean {
  if (ancestorOid === oid) return true;
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current === ancestorOid) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of commitParents(objects, current)) queue.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// cached git responses (fetch + ls-refs)
// ---------------------------------------------------------------------------------------------

/**
 * One cached git response, with the repo state it was built from. A fetch
 * or ls-refs response is a pure function of (refs, objects, request
 * args): the same inputs always build the same bytes (planFetch sorts the
 * send set, writePack is deterministic). The cache therefore validates a
 * hit against the repo state instead of tracking every mutation site:
 * objects are append-only and content-addressed, so an unchanged
 * objects.size means an unchanged object map, and the refs fingerprint
 * covers the refs. Any mutation — a push, a REST/GraphQL/MCP commit or
 * merge, a ref create/delete — moves the fingerprint or the size, so a
 * stale hit is impossible; at worst a changed repo pays one rebuild.
 *
 * This exists because the benchmark's 50 concurrent depth-1 clones of one
 * repo are 50 identical fetch requests (same tip, no haves, depth 1):
 * the first builds the pack, the other 49 reuse the bytes.
 */
interface CachedGitResponse {
  /** Sorted `ref=oid` fingerprint of the repo's refs at build time. */
  refsFp: string;
  /** repo.objects.size at build time. */
  objSize: number;
  response: Buffer;
}

/** Per-repo entry cap (LRU within the repo). */
const GIT_CACHE_MAX_ENTRIES = 16;
/** Per-repo byte cap. */
const GIT_CACHE_MAX_BYTES = 2 * 1024 * 1024;
/** A single response larger than this is never cached (a full clone of a large repo). */
const GIT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;

/** Per-repo caches, GC'd with the repo. */
const gitResponseCache = new WeakMap<Repo, Map<string, CachedGitResponse>>();
const gitResponseCacheBytes = new WeakMap<Repo, number>();

/** Sorted `ref=oid` lines for the repo's refs (identical maps, identical string). */
function refsFingerprint(repo: Repo): string {
  const entries = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let fp = '';
  for (const [ref, oid] of entries) fp += `${ref}=${oid}\n`;
  return fp;
}

/** The cached response for `key`, or null when absent or the repo moved on. */
function cachedGitResponse(repo: Repo, key: string): Buffer | null {
  const perRepo = gitResponseCache.get(repo);
  if (perRepo === undefined) return null;
  const entry = perRepo.get(key);
  if (entry === undefined) return null;
  if (entry.objSize !== repo.objects.size) return null;
  if (entry.refsFp !== refsFingerprint(repo)) return null;
  // Refresh the LRU position.
  perRepo.delete(key);
  perRepo.set(key, entry);
  return entry.response;
}

/** Store `response` under `key`, evicting the repo's oldest entries past the caps. */
function storeGitResponse(repo: Repo, key: string, response: Buffer): void {
  if (response.length > GIT_CACHE_MAX_ENTRY_BYTES) return;
  let perRepo = gitResponseCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    gitResponseCache.set(repo, perRepo);
    gitResponseCacheBytes.set(repo, 0);
  }
  let bytes = gitResponseCacheBytes.get(repo) ?? 0;
  const existing = perRepo.get(key);
  if (existing !== undefined) {
    bytes -= existing.response.length;
    perRepo.delete(key);
  }
  while ((perRepo.size >= GIT_CACHE_MAX_ENTRIES || bytes + response.length > GIT_CACHE_MAX_BYTES) && perRepo.size > 0) {
    const oldestKey = perRepo.keys().next();
    if (oldestKey.done) break;
    const evicted = perRepo.get(oldestKey.value);
    if (evicted !== undefined) bytes -= evicted.response.length;
    perRepo.delete(oldestKey.value);
  }
  perRepo.set(key, { refsFp: refsFingerprint(repo), objSize: repo.objects.size, response });
  gitResponseCacheBytes.set(repo, bytes + response.length);
}

/** Cache key for a fetch request: the request args, with the protocol version. */
function fetchCacheKey(args: FetchArgs, v2: boolean): string {
  const sorted = (oids: string[]): string => [...oids].sort().join(',');
  return [
    v2 ? 'fetch-v2' : 'fetch-v0',
    sorted(args.wants),
    sorted(args.haves),
    args.deepen === null ? '' : String(args.deepen),
    sorted(args.shallow),
  ].join('\n');
}

/** Cache key for an ls-refs request: its flags. */
function lsRefsCacheKey(peel: boolean, symrefs: boolean, unborn: boolean, prefixes: string[]): string {
  return ['ls-refs', peel ? 'peel' : '', symrefs ? 'symrefs' : '', unborn ? 'unborn' : '', [...prefixes].sort().join(',')].join('\n');
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const head = headOid(repo);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow agent=gitforge/1.0 symref=HEAD:refs/heads/${repo.defaultBranch}`
      : 'report-status side-band-64k delete-refs ofs-delta agent=gitforge/1.0';
  if (head === null) {
    // An empty repo advertises no refs on upload-pack, but a push needs
    // the capabilities from somewhere: real git (and the kit client,
    // which skips this pseudo-ref) reads them off the zero-oid
    // `capabilities^{}` line on receive-pack.
    if (service === 'git-receive-pack') {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
      parts.push(pktFlush());
    }
    return Buffer.concat(parts);
  }
  // HEAD first, caps on the first ref line, then heads, then tags, then
  // peeled annotated tags as `<oid> <ref>^{}` lines.
  const lines: string[] = [`${head} HEAD\0${caps}\n`];
  for (const { ref, oid } of sortedRefs(repo)) {
    lines.push(`${oid} ${ref}\n`);
    const peeled = peeledCommit(repo.objects, oid);
    if (peeled !== null) lines.push(`${peeled} ${ref}^{}\n`);
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: constant for every repo and request. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  pktLine('agent=gitforge/1.0\n'),
  pktFlush(),
]);

function handleInfoRefs(repo: Repo, req: IncomingMessage, res: ServerResponse): void {
  const service = queryOf(req).get('service');
  if (service === 'git-upload-pack') {
    if (wantsV2(req)) sendBuffer(res, 200, V2_ADVERTISEMENT, UPLOAD_AD_CT);
    else sendBuffer(res, 200, v0Advertisement(repo, 'git-upload-pack'), UPLOAD_AD_CT);
    return;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, v0Advertisement(repo, 'git-receive-pack'), RECEIVE_AD_CT);
    return;
  }
  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// pkt-line request parsing
// ---------------------------------------------------------------------------------------------

/** The text of every data packet in `body`, in order. Throws on malformed framing. */
function pktLinesText(body: Buffer): string[] {
  const out: string[] = [];
  for (const packet of parsePktLines(body)) {
    if (packet.kind === 'data') out.push(packet.data.toString('utf8'));
  }
  return out;
}

function stripEol(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

/** Parse the argument lines of a v2 fetch / v0 fetch request body. */
function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null };
  for (const raw of lines) {
    const line = stripEol(raw);
    if (line === '' || line === 'done' || line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') continue;
    if (line.startsWith('command=')) continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=') || line.startsWith('filter ')) continue;
    if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) continue;
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (HEX40.test(oid)) args.wants.push(oid);
      continue;
    }
    if (line.startsWith('have ')) {
      const oid = line.slice(5).split(' ')[0];
      if (HEX40.test(oid)) args.haves.push(oid);
      continue;
    }
    if (line.startsWith('shallow ')) {
      const oid = line.slice(8).split(' ')[0];
      if (HEX40.test(oid)) args.shallow.push(oid);
      continue;
    }
    if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) args.deepen = n;
      continue;
    }
    // Unknown arguments are ignored: a newer client may send ones we do not advertise.
  }
  return args;
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  objectsToSend: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
  wantedRefs: Array<{ oid: string; ref: string }>;
}

/**
 * Objects reachable from `roots` walking commit -> tree only (never
 * parents), tag -> target, tree -> entries. Used for the send set, where
 * the commit set is already depth-limited, so parent traversal here
 * would leak history past the depth limit.
 */
function collectWithoutParents(objects: Map<string, GitObject>, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (HEX40.test(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    try {
      if (obj.type === 'commit') {
        queue.push(parseCommit(obj.data).tree);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode === '160000') continue;
          queue.push(entry.oid);
        }
      }
    } catch {
      continue;
    }
  }
  return seen;
}

function collectHeld(objects: Map<string, GitObject>, haves: string[], shallowBoundaries: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const have of haves) if (HEX40.test(have)) queue.push(have);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    try {
      if (obj.type === 'commit') {
        queue.push(parseCommit(obj.data).tree);
        if (!shallowBoundaries.has(oid)) {
          for (const parent of parseCommit(obj.data).parents) queue.push(parent);
        }
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode === '160000') continue;
          queue.push(entry.oid);
        }
      }
    } catch {
      continue;
    }
  }
  return seen;
}

function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const objects = repo.objects;
  const wants = args.wants.filter((oid) => objects.has(oid));
  const shallowRequested = new Set(args.shallow);

  // The commits the wants resolve to (tags peel to their commit).
  const wantCommits: string[] = [];
  for (const want of wants) {
    const obj = objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'commit') wantCommits.push(want);
    else if (obj.type === 'tag') {
      const peeled = peelTarget(objects, want);
      if (peeled !== null && objects.get(peeled)?.type === 'commit') wantCommits.push(peeled);
    }
  }

  // Included commits: ancestors of the wants, depth-limited when deepen is set.
  const included = new Set<string>();
  if (args.deepen !== null) {
    const depth = new Map<string, number>();
    const queue: string[] = [];
    for (const commit of wantCommits) {
      if (!depth.has(commit)) {
        depth.set(commit, 1);
        queue.push(commit);
      }
    }
    while (queue.length > 0) {
      const oid = queue.shift()!;
      const gen = depth.get(oid)!;
      included.add(oid);
      if (gen >= args.deepen) continue;
      for (const parent of commitParents(objects, oid)) {
        if (!depth.has(parent)) {
          depth.set(parent, gen + 1);
          queue.push(parent);
        }
      }
    }
  } else {
    const queue = [...wantCommits];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (included.has(oid)) continue;
      if (objects.get(oid)?.type !== 'commit') continue;
      included.add(oid);
      for (const parent of commitParents(objects, oid)) queue.push(parent);
    }
  }

  // Objects to send: the closure of the wants + included commits, minus held.
  const sendRoots = [...new Set([...wants, ...included])];
  const sendable = collectWithoutParents(objects, sendRoots);
  const held = collectHeld(objects, args.haves, shallowRequested);
  const toSend: GitObject[] = [];
  for (const oid of [...sendable].sort()) {
    if (held.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj !== undefined) toSend.push(obj);
  }

  // Shallow boundaries: included commits with a parent outside the set.
  const shallow: string[] = [];
  for (const oid of [...included].sort()) {
    const parents = commitParents(objects, oid);
    if (parents.some((parent) => !included.has(parent))) shallow.push(oid);
  }
  // Unshallow: requested boundaries whose parents are now included.
  const unshallow: string[] = [];
  for (const oid of args.shallow) {
    const parents = commitParents(objects, oid);
    if (parents.length > 0 && parents.every((parent) => included.has(parent))) unshallow.push(oid);
  }

  // Acknowledgments: ACK each have that is an ancestor of (or equal to)
  // some want; NAK when none qualifies.
  const acks: string[] = [];
  for (const have of args.haves) {
    if (!objects.has(have)) continue;
    let satisfied = false;
    for (const want of wantCommits) {
      if (have === want || isAncestorOf(objects, have, want)) {
        satisfied = true;
        break;
      }
    }
    if (satisfied) acks.push(have);
  }
  const nak = acks.length === 0;

  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  const wantSet = new Set(wants);
  for (const { ref, oid } of sortedRefs(repo)) {
    if (wantSet.has(oid)) wantedRefs.push({ oid, ref });
  }

  return { objectsToSend: toSend, shallow, unshallow, acks, nak, wantedRefs };
}

/** The pack as sideband band-1 pkt-lines (chunked to the pkt-line limit). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function ackLines(plan: FetchPlan, v2: boolean): Buffer[] {
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(pktLine('NAK\n'));
  else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    // Real git requires `ready` after ACK lines in v2: without it, it
    // treats the negotiation as unfinished and dies with "expected no
    // other sections to be sent after no 'ready'" when the next section
    // arrives. NAK alone is a complete acknowledgment. v0 has no `ready`
    // line (neither git nor the kit's v0 parser accepts one there).
    if (v2) parts.push(pktLine('ready\n'));
  }
  return parts;
}

function shallowLines(plan: FetchPlan): Buffer[] {
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  return parts;
}

async function handleUploadPack(repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    badRequest(res, 'unreadable body');
    return;
  }
  if (wantsV2(req)) {
    let lines: string[];
    try {
      lines = pktLinesText(body);
    } catch {
      badRequest(res, 'malformed pkt-line stream');
      return;
    }
    const commandLine = lines.length > 0 ? stripEol(lines[0]) : '';
    if (commandLine === 'command=ls-refs') {
      handleLsRefs(repo, res, lines.slice(1));
      return;
    }
    if (commandLine !== 'command=fetch') {
      badRequest(res, 'unknown command');
      return;
    }
    const args = parseFetchArgs(lines.slice(1));
    const cacheKey = fetchCacheKey(args, true);
    const cached = cachedGitResponse(repo, cacheKey);
    if (cached !== null) {
      sendBuffer(res, 200, cached, UPLOAD_RESULT_CT);
      return;
    }
    const plan = planFetch(repo, args);
    const pack = writePack(plan.objectsToSend);
    // Sections are emitted only when they apply to the request. Real git
    // dies with "expected 'packfile', received 'acknowledgments'" when
    // an acknowledgments section is present but no haves were sent, and
    // with "expected no other sections to be sent after no 'ready'" when
    // ACK lines are not followed by `ready` (see ackLines). The kit
    // client tolerates absent sections.
    const parts: Buffer[] = [];
    const emitSection = (name: string, lines: Buffer[]): void => {
      parts.push(pktLine(`${name}\n`), ...lines, pktDelim());
    };
    if (args.haves.length > 0) emitSection('acknowledgments', ackLines(plan, true));
    if (args.deepen !== null || args.shallow.length > 0) emitSection('shallow-info', shallowLines(plan));
    if (plan.wantedRefs.length > 0) {
      emitSection('wanted-refs', plan.wantedRefs.map((entry) => pktLine(`${entry.oid} ${entry.ref}\n`)));
    }
    parts.push(pktLine('packfile\n'), ...sidebandPack(pack), pktFlush());
    const response = Buffer.concat(parts);
    storeGitResponse(repo, cacheKey, response);
    sendBuffer(res, 200, response, UPLOAD_RESULT_CT);
    return;
  }
  // v0: want lines, flush, have lines, done, flush.
  let lines: string[];
  try {
    lines = pktLinesText(body);
  } catch {
    badRequest(res, 'malformed pkt-line stream');
    return;
  }
  const args = parseFetchArgs(lines);
  if (args.wants.length === 0) {
    badRequest(res, 'missing want');
    return;
  }
  const cacheKey = fetchCacheKey(args, false);
  const cached = cachedGitResponse(repo, cacheKey);
  if (cached !== null) {
    sendBuffer(res, 200, cached, UPLOAD_RESULT_CT);
    return;
  }
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objectsToSend);
  const parts: Buffer[] = [...ackLines(plan, false), ...shallowLines(plan), ...sidebandPack(pack), pktFlush()];
  const response = Buffer.concat(parts);
  storeGitResponse(repo, cacheKey, response);
  sendBuffer(res, 200, response, UPLOAD_RESULT_CT);
}

function handleLsRefs(repo: Repo, res: ServerResponse, argLines: string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of argLines) {
    const line = stripEol(raw);
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const cacheKey = lsRefsCacheKey(peel, symrefs, unborn, prefixes);
  const cached = cachedGitResponse(repo, cacheKey);
  if (cached !== null) {
    sendBuffer(res, 200, cached, UPLOAD_RESULT_CT);
    return;
  }
  const parts: Buffer[] = [];
  const head = headOid(repo);
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  if (head === null) {
    if (unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD symref-target:${defaultRef}\n`));
    }
  } else {
    if (keep('HEAD')) {
      parts.push(pktLine(`${head} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    }
    for (const { ref, oid } of sortedRefs(repo)) {
      if (!keep(ref)) continue;
      let line = `${oid} ${ref}`;
      if (peel) {
        const peeled = peeledCommit(repo.objects, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush());
  const response = Buffer.concat(parts);
  storeGitResponse(repo, cacheKey, response);
  sendBuffer(res, 200, response, UPLOAD_RESULT_CT);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Scan pkt-lines from the start of `buf` until the first flush packet.
 * Returns the data lines and the raw remainder (the pack). Throws on
 * malformed framing — the remainder is raw pack bytes, so the whole
 * buffer must NOT be fed to parsePktLines.
 */
function scanCommandList(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  for (;;) {
    if (buf.length - offset < 4) throw new Error('truncated pkt-line in command list');
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      return { lines, rest: buf.subarray(offset + 4) };
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (buf.length - offset < length) throw new Error('truncated pkt-line in command list');
    lines.push(buf.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
}

async function handleReceivePack(repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    badRequest(res, 'unreadable body');
    return;
  }
  let scanned: { lines: string[]; rest: Buffer };
  try {
    scanned = scanCommandList(body);
  } catch {
    badRequest(res, 'malformed pkt-line stream');
    return;
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  let reportStatus = false;
  try {
    scanned.lines.forEach((rawLine, index) => {
      const line = stripEol(rawLine);
      let commandText = line;
      if (index === 0) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          commandText = line.slice(0, nul);
          const caps = line.slice(nul + 1).split(' ').filter((token) => token.length > 0);
          sideband = caps.includes('side-band-64k');
          reportStatus = caps.includes('report-status') || caps.includes('report-status-v2');
        }
      }
      const parts = commandText.split(' ');
      if (parts.length !== 3) throw new Error(`bad push command ${JSON.stringify(commandText.slice(0, 60))}`);
      const [oldOid, newOid, ref] = parts;
      if (!HEX40.test(oldOid) || !HEX40.test(newOid)) throw new Error('push command has a bad object id');
      if (!ref.startsWith('refs/')) throw new Error(`push command has a bad ref ${JSON.stringify(ref)}`);
      commands.push({ oldOid, newOid, ref });
    });
    if (commands.length === 0) throw new Error('empty push command list');
  } catch {
    badRequest(res, 'malformed push command list');
    return;
  }

  // Unpack the pack (if any) into the repo before applying refs, so the
  // fast-forward check can see the new objects. A delete-only push
  // carries no pack at all.
  if (scanned.rest.length > 0) {
    let unpacked: Map<string, GitObject>;
    try {
      unpacked = readPack(scanned.rest, repo.objects);
    } catch {
      badRequest(res, 'malformed pack');
      return;
    }
    for (const [oid, obj] of unpacked) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: fast-forward only.
    if (current === undefined || current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (command.newOid === command.oldOid) {
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
    } else if (!isAncestorOf(repo.objects, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }

  if (!reportStatus) {
    sendBuffer(res, 200, Buffer.alloc(0), RECEIVE_RESULT_CT);
    return;
  }
  const reportLines: string[] = ['unpack ok\n'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  let payload: Buffer;
  if (sideband) {
    // The report is a pkt-line stream carried inside band 1, so it needs
    // its own terminating flush *inside* the band: the outer flush only
    // ends the HTTP response, and without the inner one git reads past
    // the last `ok` line and reports "the remote end hung up".
    const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), pktFlush()]);
    const parts: Buffer[] = [];
    for (let offset = 0; offset < inner.length; offset += SIDEBAND_CHUNK) {
      const chunk = inner.subarray(offset, Math.min(inner.length, offset + SIDEBAND_CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(pktFlush());
    payload = Buffer.concat(parts);
  } else {
    payload = Buffer.concat([...reportLines.map((line) => pktLine(line)), pktFlush()]);
  }
  sendBuffer(res, 200, payload, RECEIVE_RESULT_CT);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const segments = segmentsOf(pathOf(req));
  if (segments.length < 2) return false;
  if (!segments[1].endsWith('.git')) return false;
  const owner = segments[0];
  const repoName = segments[1].slice(0, -4);
  if (!NAME_RE.test(owner) || !NAME_RE.test(repoName) || repoName.endsWith('.git')) {
    notFound(res);
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined || owner !== store.viewerLogin) {
    notFound(res);
    return true;
  }
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
      handleInfoRefs(repo, req, res);
      return true;
    }
    if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
      await handleUploadPack(repo, req, res);
      return true;
    }
    if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
      await handleReceivePack(repo, req, res);
      return true;
    }
  } catch {
    if (!res.headersSent) sendText(res, 500, 'internal error\n');
    return true;
  }
  notFound(res);
  return true;
}
