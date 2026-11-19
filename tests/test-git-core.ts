// Tests for src/git-pkt.ts, src/git-core.ts and src/git-pack.ts.
// Run: ~/.local/node22/bin/node --experimental-strip-types tests/test-git-core.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { pktLine, pktFlush, pktDelim, pktEnd, parsePktLines } from '../src/git-pkt.ts';
import {
  hashObject, storeObject, parseCommit, buildCommit, parseTree, buildTree,
  parseTag, buildTag, readTreeRecursive, writeTreeRecursive, commitObject,
  collectReachable, isAncestor, mergeBase, diffTrees, lineDiff,
} from '../src/git-core.ts';
import { readPack, writePack } from '../src/git-pack.ts';
import type { GitObject, ObjType } from '../src/types.ts';

const AUTHOR = 'Ada Lovelace <ada@example.invalid> 1700000000 +0000';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's empty tree

function sha1Of(type: string, data: Buffer): string {
  return createHash('sha1').update(Buffer.from(`${type} ${data.length}\0`, 'utf8')).update(data).digest('hex');
}

// --- pkt-line ---------------------------------------------------------------
{
  assert.equal(pktFlush().toString('ascii'), '0000');
  assert.equal(pktDelim().toString('ascii'), '0001');
  assert.equal(pktEnd().toString('ascii'), '0002');
  const line = pktLine('hello\n');
  assert.equal(line.toString('ascii'), '000ahello\n');
  assert.equal(pktLine(Buffer.from('abc')).toString('ascii'), '0007abc');
  const parsed = parsePktLines(Buffer.concat([pktLine('a\n'), pktFlush(), pktDelim(), pktEnd(), pktLine('b')]));
  assert.equal(parsed.length, 5);
  assert.equal(parsed[0].kind, 'data');
  if (parsed[0].kind === 'data') assert.equal(parsed[0].data.toString(), 'a\n');
  assert.equal(parsed[1].kind, 'flush');
  assert.equal(parsed[2].kind, 'delim');
  assert.equal(parsed[3].kind, 'end');
  assert.equal(parsed[4].kind, 'data');
  assert.deepEqual(parsePktLines(Buffer.alloc(0)), []);
  assert.throws(() => parsePktLines(Buffer.from('0003', 'ascii')), /invalid pkt-line length 0003/);
  assert.throws(() => parsePktLines(Buffer.from('000aab', 'ascii')), /truncated pkt-line/);
  assert.throws(() => parsePktLines(Buffer.from('00', 'ascii')), /truncated pkt-line/);
  assert.throws(() => parsePktLines(Buffer.from('zzzz', 'ascii')), /invalid pkt-line length/);
  assert.throws(() => parsePktLines(Buffer.from('fff1', 'ascii')), /exceeds 65520/);
  assert.throws(() => pktLine(Buffer.alloc(65517)), /over the .* maximum/);
}

// --- hashObject / commit round-trip -----------------------------------------
{
  // Cross-check against node:crypto directly, and against git's known empty-tree id.
  assert.equal(hashObject('tree', Buffer.alloc(0)), EMPTY_TREE);
  assert.equal(hashObject('blob', Buffer.from('hello\n')), sha1Of('blob', Buffer.from('hello\n')));
  assert.equal(hashObject('blob', Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');

  const data = buildCommit({
    tree: EMPTY_TREE, parents: [], author: AUTHOR, committer: AUTHOR,
    message: 'initial\n', extra: ['encoding UTF-8', 'gpgsig -----BEGIN', ' continuation'],
  });
  // oid matches an independent SHA-1 computation
  assert.equal(hashObject('commit', data), sha1Of('commit', data));
  const parsed = parseCommit(data);
  assert.equal(parsed.tree, EMPTY_TREE);
  assert.deepEqual(parsed.parents, []);
  assert.equal(parsed.author, AUTHOR);
  assert.equal(parsed.committer, AUTHOR);
  assert.equal(parsed.message, 'initial\n');
  assert.deepEqual(parsed.extra, ['encoding UTF-8', 'gpgsig -----BEGIN', ' continuation']);
  // byte-for-byte round-trip, including extra headers
  assert.ok(buildCommit(parsed).equals(data));
  // parents round-trip
  const child = buildCommit({
    tree: EMPTY_TREE, parents: [hashObject('commit', data)], author: AUTHOR, committer: AUTHOR, message: 'second\n',
  });
  assert.deepEqual(parseCommit(child).parents, [hashObject('commit', data)]);
  assert.throws(() => parseCommit(Buffer.from('nonsense\n\nmsg\n')), /no valid tree/);
}

// --- tree sort order ----------------------------------------------------------
{
  const blobOid = hashObject('blob', Buffer.from('x'));
  const dirOid = hashObject('tree', Buffer.alloc(0));
  // Git's tree sort compares a directory as if its name had a trailing "/".
  // NOTE: that puts file "a.txt" BEFORE directory "a": '.' is 0x2e and '/'
  // is 0x2f, so "a.txt" < "a/". Verified against real git (git ls-tree
  // lists a.txt, then a, then b). The kit's buildTree does the same
  // Buffer.compare(name + "/") comparison.
  const built = buildTree([
    { mode: '100644', name: 'a.txt', oid: blobOid },
    { mode: '40000', name: 'a', oid: dirOid },
    { mode: '100644', name: 'b', oid: blobOid },
  ]);
  assert.deepEqual(parseTree(built).map((e) => e.name), ['a.txt', 'a', 'b']);
  assert.deepEqual(parseTree(built)[1], { mode: '40000', name: 'a', oid: dirOid });
  // Stored order is preserved by parseTree (it does not re-sort).
  const unsorted = Buffer.concat([
    Buffer.from(`100644 z\0`, 'utf8'), Buffer.from(blobOid, 'hex'),
    Buffer.from(`100644 a\0`, 'utf8'), Buffer.from(blobOid, 'hex'),
  ]);
  assert.deepEqual(parseTree(unsorted).map((e) => e.name), ['z', 'a']);
  assert.throws(() => parseTree(Buffer.from('99999 x\0' + '0'.repeat(40), 'utf8')), /not octal/);
  assert.throws(() => buildTree([{ mode: '100644', name: 'x', oid: 'not-an-oid' }]), /bad object id/);
}

// --- tag round-trip -----------------------------------------------------------
{
  const target = hashObject('commit', Buffer.from('x'));
  const data = buildTag({ object: target, type: 'commit', tag: 'v1', tagger: AUTHOR, message: 'release\n' });
  const parsed = parseTag(data);
  assert.equal(parsed.object, target);
  assert.equal(parsed.type, 'commit');
  assert.equal(parsed.tag, 'v1');
  assert.equal(parsed.tagger, AUTHOR);
  assert.equal(parsed.message, 'release\n');
  assert.ok(buildTag(parsed).equals(data));
}

// --- writeTreeRecursive / readTreeRecursive -----------------------------------
{
  const objects = new Map<string, GitObject>();
  const t1 = writeTreeRecursive(objects, null, new Map([
    ['a/b/c.txt', Buffer.from('deep\n')],
    ['x.txt', Buffer.from('top\n')],
    ['a/d.txt', Buffer.from('sibling\n')],
  ]));
  let flat = readTreeRecursive(objects, t1);
  assert.deepEqual([...flat.keys()].sort(), ['a/b/c.txt', 'a/d.txt', 'x.txt']);
  assert.equal(flat.get('a/b/c.txt')?.mode, '100644');
  assert.equal(objects.get(flat.get('a/b/c.txt')!.oid)?.data.toString(), 'deep\n');

  // modify one nested file, add another, delete a top-level file
  const t2 = writeTreeRecursive(objects, t1, new Map([
    ['a/b/c.txt', Buffer.from('deeper\n')],
    ['new.txt', Buffer.from('new\n')],
    ['x.txt', null],
  ]));
  flat = readTreeRecursive(objects, t2);
  assert.deepEqual([...flat.keys()].sort(), ['a/b/c.txt', 'a/d.txt', 'new.txt']);
  assert.equal(objects.get(flat.get('a/b/c.txt')!.oid)?.data.toString(), 'deeper\n');

  // deleting the last file under a/b prunes a/b, and deleting a/d.txt prunes a entirely
  const t3 = writeTreeRecursive(objects, t2, new Map([['a/b/c.txt', null], ['a/d.txt', null]]));
  flat = readTreeRecursive(objects, t3);
  assert.deepEqual([...flat.keys()].sort(), ['new.txt']);
  // deleting a missing file is a no-op; deleting the last file yields the empty tree
  const t4 = writeTreeRecursive(objects, t3, new Map([['nope.txt', null]]));
  assert.equal(t4, t3);
  const t5 = writeTreeRecursive(objects, t3, new Map([['new.txt', null]]));
  assert.equal(t5, EMPTY_TREE);
  assert.equal(readTreeRecursive(objects, t5).size, 0);
  // a file replacing a directory, and a directory replacing a file
  const t6 = writeTreeRecursive(objects, t1, new Map([['a', Buffer.from('now a file\n')]]));
  assert.deepEqual([...readTreeRecursive(objects, t6).keys()].sort(), ['a', 'x.txt']);
  const t7 = writeTreeRecursive(objects, t6, new Map([['a/inner.txt', Buffer.from('inner\n')]]));
  assert.deepEqual([...readTreeRecursive(objects, t7).keys()].sort(), ['a/inner.txt', 'x.txt']);

  // gitlink entries are skipped, not recursed into (missing target must not throw)
  const gitlinkTree = buildTree([
    { mode: '100644', name: 'f.txt', oid: storeObject(objects, 'blob', Buffer.from('f')) },
    { mode: '160000', name: 'sub', oid: '1111111111111111111111111111111111111111' },
  ]);
  const gitlinkOid = storeObject(objects, 'tree', gitlinkTree);
  assert.deepEqual([...readTreeRecursive(objects, gitlinkOid).keys()], ['f.txt']);
}

// --- ancestors / merge-base ---------------------------------------------------
{
  const objects = new Map<string, GitObject>();
  assert.equal(storeObject(objects, 'tree', Buffer.alloc(0)), EMPTY_TREE);
  const mk = (parents: string[], message = 'c\n'): string => commitObject(objects, {
    tree: EMPTY_TREE, parents, author: AUTHOR, committer: AUTHOR, message,
  });
  const c1 = mk([]);
  const c2 = mk([c1]);
  const c3 = mk([c2]);
  const c2b = mk([c2], 'branch\n');
  const c4 = mk([c3, c2b], 'merge\n'); // merge commit

  assert.equal(isAncestor(objects, c1, c3), true);
  assert.equal(isAncestor(objects, c3, c1), false);
  assert.equal(isAncestor(objects, c2, c2), true);
  assert.equal(isAncestor(objects, c1, c2b), true);
  assert.equal(isAncestor(objects, c2b, c3), false);
  assert.equal(isAncestor(objects, '0'.repeat(40), c3), false);
  assert.equal(isAncestor(objects, c1, '0'.repeat(40)), false);

  assert.equal(mergeBase(objects, c3, c2b), c2);
  assert.equal(mergeBase(objects, c1, c3), c1);
  assert.equal(mergeBase(objects, c3, c3), c3);
  assert.equal(mergeBase(objects, c4, c2b), c2b);
  assert.equal(mergeBase(objects, c4, c3), c3);
  const unrelated = mk([], 'unrelated\n');
  assert.equal(mergeBase(objects, c3, unrelated), null);

  // collectReachable: closure, missing tips skipped, no infinite loop
  const reachable = collectReachable(objects, [c4]);
  assert.ok(reachable.has(c4) && reachable.has(c3) && reachable.has(c2b) && reachable.has(c2) && reachable.has(c1));
  assert.ok(reachable.has(EMPTY_TREE));
  assert.equal(collectReachable(objects, ['0'.repeat(40)]).size, 0);
  assert.equal(collectReachable(objects, [c1, '0'.repeat(40)]).size, 2); // c1 + empty tree
}

// --- diffTrees / lineDiff -----------------------------------------------------
{
  const objects = new Map<string, GitObject>();
  const base = writeTreeRecursive(objects, null, new Map([
    ['a.txt', Buffer.from('hello\n')],
    ['b.txt', Buffer.from('bye\n')],
    ['sub/keep.txt', Buffer.from('keep\n')],
  ]));
  const head = writeTreeRecursive(objects, base, new Map([
    ['a.txt', Buffer.from('hello world\n')],
    ['b.txt', null],
    ['c.txt', Buffer.from('added\n')],
  ]));
  assert.deepEqual(diffTrees(objects, base, head), [
    { path: 'a.txt', status: 'modified', oldOid: hashObject('blob', Buffer.from('hello\n')), newOid: hashObject('blob', Buffer.from('hello world\n')) },
    { path: 'b.txt', status: 'deleted', oldOid: hashObject('blob', Buffer.from('bye\n')), newOid: null },
    { path: 'c.txt', status: 'added', oldOid: null, newOid: hashObject('blob', Buffer.from('added\n')) },
  ]);
  assert.deepEqual(diffTrees(objects, null, base).map((d) => d.status), ['added', 'added', 'added']);
  assert.deepEqual(diffTrees(objects, base, base), []);
  assert.deepEqual(diffTrees(objects, base, null).map((d) => d.status), ['deleted', 'deleted', 'deleted']);

  assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nx\nc\nd\n'), { additions: 2, deletions: 1 });
  assert.deepEqual(lineDiff('same\n', 'same\n'), { additions: 0, deletions: 0 });
  assert.deepEqual(lineDiff('', ''), { additions: 0, deletions: 0 });
  assert.deepEqual(lineDiff('a\n', ''), { additions: 0, deletions: 1 });
  assert.deepEqual(lineDiff('', 'a\n'), { additions: 1, deletions: 0 });
  assert.deepEqual(lineDiff('a\nb\n', 'b\na\n'), { additions: 1, deletions: 1 });
}

// --- pack write/read round-trip -----------------------------------------------
function packHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function rawPack(entries: Buffer[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([header, ...entries]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function deltaVarint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

/** git OFS_DELTA negative-offset encoding. */
function ofsVarint(distance: number): Buffer {
  const bytes: number[] = [distance & 0x7f];
  let v = distance >> 7;
  while (v > 0) {
    v -= 1;
    bytes.push(0x80 | (v & 0x7f));
    v >>= 7;
  }
  return Buffer.from(bytes.reverse());
}

function copyOp(offset: number, size: number): Buffer {
  let op = 0x80;
  const rest: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const byte = (offset >> (8 * i)) & 0xff;
    if (byte !== 0) {
      op |= 1 << i;
      rest.push(byte);
    }
  }
  for (let i = 0; i < 3; i += 1) {
    const byte = (size >> (8 * i)) & 0xff;
    if (byte !== 0) {
      op |= 1 << (4 + i);
      rest.push(byte);
    }
  }
  return Buffer.from([op, ...rest]);
}

function insertOp(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([data.length]), data]);
}

function makeDelta(base: Buffer, target: Buffer, ops: Buffer): Buffer {
  return Buffer.concat([deltaVarint(base.length), deltaVarint(target.length), ops]);
}

{
  const objects = new Map<string, GitObject>();
  const blobOid = storeObject(objects, 'blob', Buffer.from('hello pack\n'));
  const treeOid = writeTreeRecursive(objects, null, new Map([['f.txt', Buffer.from('hello pack\n')]]));
  const commitOid = commitObject(objects, { tree: treeOid, parents: [], author: AUTHOR, committer: AUTHOR, message: 'pack me\n' });
  const tagOid = storeObject(objects, 'tag', buildTag({ object: commitOid, type: 'commit', tag: 'v1', tagger: AUTHOR, message: 't\n' }));
  const list = [...objects.values()];
  const pack = writePack(list);
  assert.equal(pack.subarray(0, 4).toString('ascii'), 'PACK');
  assert.equal(pack.readUInt32BE(4), 2);
  assert.equal(pack.readUInt32BE(8), list.length);
  const back = readPack(pack, new Map());
  assert.equal(back.size, objects.size);
  for (const [oid, obj] of objects) {
    const got = back.get(oid);
    assert.ok(got, `missing ${oid}`);
    assert.equal(got!.type, obj.type);
    assert.ok(got!.data.equals(obj.data));
  }
  assert.ok(back.has(blobOid) && back.has(treeOid) && back.has(commitOid) && back.has(tagOid));
  // empty pack round-trips
  assert.equal(readPack(writePack([]), new Map()).size, 0);
  // tampered trailer throws
  const tampered = Buffer.from(pack);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => readPack(tampered, new Map()), /trailer mismatch/);
  // bad version throws (with a correct trailer)
  const badVersion = rawPack([]);
  badVersion.writeUInt32BE(99, 4);
  const fixed = Buffer.concat([badVersion.subarray(0, badVersion.length - 20), createHash('sha1').update(badVersion.subarray(0, badVersion.length - 20)).digest()]);
  assert.throws(() => readPack(fixed, new Map()), /unsupported pack version/);
  assert.throws(() => readPack(Buffer.from('NOPE'), new Map()), /too short/);
}

{
  // Hand-built REF_DELTA pack: base blob in the pack.
  const base = Buffer.from('hello world\n');
  const target = Buffer.from('hello brave new world\n');
  const baseOid = hashObject('blob', base);
  const delta = makeDelta(base, target, Buffer.concat([
    copyOp(0, 6), insertOp(Buffer.from('brave new ')), copyOp(6, 6),
  ]));
  const baseEntry = Buffer.concat([packHeader(3, base.length), deflateSync(base)]);
  const deltaEntry = Buffer.concat([
    packHeader(7, delta.length), Buffer.from(baseOid, 'hex'), deflateSync(delta),
  ]);
  const pack = rawPack([baseEntry, deltaEntry]);
  const out = readPack(pack, new Map());
  assert.equal(out.size, 2);
  assert.ok(out.get(baseOid)?.data.equals(base));
  const targetOid = hashObject('blob', target);
  assert.ok(out.get(targetOid), 'ref-delta target missing');
  assert.equal(out.get(targetOid)?.type, 'blob');
  assert.ok(out.get(targetOid)?.data.equals(target));

  // Thin pack: the same delta alone, base supplied via `have`.
  const thin = rawPack([deltaEntry]);
  const thinOut = readPack(thin, new Map([[baseOid, { type: 'blob' as ObjType, data: base }]]));
  assert.equal(thinOut.size, 1);
  assert.ok(thinOut.get(targetOid)?.data.equals(target));
  // Neither in pack nor in have -> throws.
  assert.throws(() => readPack(thin, new Map()), /ref-delta base .* is neither/);
}

{
  // Hand-built OFS_DELTA pack.
  const base = Buffer.from('abcdefghij');
  const target = Buffer.from('abcXYZdefghij');
  const baseOid = hashObject('blob', base);
  const delta = makeDelta(base, target, Buffer.concat([
    copyOp(0, 3), insertOp(Buffer.from('XYZ')), copyOp(3, 7),
  ]));
  const baseEntry = Buffer.concat([packHeader(3, base.length), deflateSync(base)]);
  const deltaEntry = Buffer.concat([
    packHeader(6, delta.length), ofsVarint(baseEntry.length), deflateSync(delta),
  ]);
  const pack = rawPack([baseEntry, deltaEntry]);
  const out = readPack(pack, new Map());
  assert.equal(out.size, 2);
  const targetOid = hashObject('blob', target);
  assert.ok(out.get(targetOid)?.data.equals(target));
  assert.ok(out.get(baseOid)?.data.equals(base));
  // A delta against a base whose size disagrees throws.
  const badDelta = makeDelta(Buffer.from('short'), target, Buffer.concat([
    copyOp(0, 3), insertOp(Buffer.from('XYZ')), copyOp(3, 7),
  ]));
  const badEntry = Buffer.concat([
    packHeader(6, badDelta.length), ofsVarint(baseEntry.length), deflateSync(badDelta),
  ]);
  assert.throws(() => readPack(rawPack([baseEntry, badEntry]), new Map()), /delta expects/);
}

console.log('all git-core/git-pack/git-pkt tests passed');
