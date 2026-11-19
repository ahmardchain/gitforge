// Tests for src/mcp.ts: spins up a real node:http server wrapping only
// handleMcp with a fresh Store, then exercises it over fetch.
//
// Run: ~/.local/node22/bin/node --experimental-strip-types tests/test-mcp.ts
// (from the gitforge repo directory)

process.env.MAKEFUN_SHOP_TOKEN = 'test-token';

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import assert from 'node:assert/strict';
import { handleMcp } from '../src/mcp.ts';
import { Store } from '../src/store.ts';
import type { Repo } from '../src/types.ts';

const TOKEN = 'test-token';
const store = new Store();

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const handled = await handleMcp(store, req, res);
    if (!handled) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
    }
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
  }
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('server did not bind');
const BASE = `http://127.0.0.1:${address.port}`;

// ---------------------------------------------------------------- helpers

interface RpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

async function post(path: string, init: { body?: unknown; rawBody?: string; token?: string | null; method?: string; headers?: Record<string, string> }): Promise<{ status: number; text: string; json: unknown }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token !== null && init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  if (init.rawBody !== undefined) {
    headers['content-type'] = 'application/json';
  } else if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.rawBody !== undefined ? init.rawBody : init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  return { status: res.status, text, json };
}

async function rpc(method: string, params: Record<string, unknown> = {}, opts: { token?: string | null; id?: string | number } = {}): Promise<{ status: number; rpc: RpcResponse }> {
  const id = opts.id ?? 1;
  const answer = await post('/mcp', { body: { jsonrpc: '2.0', id, method, params }, token: opts.token === undefined ? TOKEN : opts.token });
  return { status: answer.status, rpc: answer.json as RpcResponse };
}

async function callTool(name: string, args: Record<string, unknown>, opts: { token?: string | null; id?: string | number } = {}): Promise<{ status: number; rpc: RpcResponse }> {
  return rpc('tools/call', { name, arguments: args }, opts);
}

function toolText(rpcRes: RpcResponse): string {
  const result = rpcRes.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const blocks = result?.content ?? [];
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
}

function toolJson(rpcRes: RpcResponse): Record<string, unknown> {
  const result = rpcRes.result as { structuredContent?: Record<string, unknown> } | undefined;
  if (result?.structuredContent !== undefined) return result.structuredContent;
  return JSON.parse(toolText(rpcRes)) as Record<string, unknown>;
}

function isError(rpcRes: RpcResponse): boolean {
  const result = rpcRes.result as { isError?: boolean } | undefined;
  return result?.isError === true;
}

// Minimal git objects by hand (SHA-1 over `<type> <len>\0<data>`).
function sha1(type: string, data: Buffer): string {
  return createHash('sha1').update(Buffer.from(`${type} ${data.length}\0`, 'utf8')).update(data).digest('hex');
}

function makeBlob(repo: Repo, content: string): string {
  const data = Buffer.from(content, 'utf8');
  const oid = sha1('blob', data);
  repo.objects.set(oid, { type: 'blob', data });
  return oid;
}

function makeTree(repo: Repo, entries: Array<{ mode: string; name: string; oid: string }>): string {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return Buffer.compare(Buffer.from(an, 'utf8'), Buffer.from(bn, 'utf8'));
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  const data = Buffer.concat(parts);
  const oid = sha1('tree', data);
  repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

function makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  const ident = 'adaiversen <adaiversen@example.invalid> 1700000000 +0000';
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  const data = Buffer.from(text, 'utf8');
  const oid = sha1('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

/** File bytes at a path in a commit's tree (single-level paths only). */
function fileAtCommit(repo: Repo, commitOid: string, path: string): string | null {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined) return null;
  const treeLine = commit.data.toString('utf8').split('\n').find((line) => line.startsWith('tree '));
  if (treeLine === undefined) return null;
  const tree = repo.objects.get(treeLine.slice(5).trim());
  if (tree === undefined) return null;
  let i = 0;
  const data = tree.data;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (name === path) {
      const blob = repo.objects.get(oid);
      return blob === undefined ? null : blob.data.toString('utf8');
    }
    i = nul + 21;
  }
  return null;
}

// ---------------------------------------------------------------- test runner

const failures: string[] = [];
let passed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------- tests

await test('no token -> 401', async () => {
  const answer = await callTool('get_repo', { owner: 'adaiversen', repo: 'x' }, { token: null });
  assert.equal(answer.status, 401);
});

await test('wrong token -> 401', async () => {
  const answer = await callTool('get_repo', { owner: 'adaiversen', repo: 'x' }, { token: 'nope' });
  assert.equal(answer.status, 401);
});

await test('server/discover returns supportedVersions + capabilities.tools + serverInfo', async () => {
  const { status, rpc: rpcRes } = await rpc('server/discover', {});
  assert.equal(status, 200);
  assert.equal(rpcRes.jsonrpc, '2.0');
  const result = rpcRes.result as { supportedVersions?: string[]; capabilities?: { tools?: unknown }; serverInfo?: { name?: string; version?: string } };
  assert.ok(Array.isArray(result.supportedVersions));
  assert.ok((result.supportedVersions as string[]).includes('2026-07-28'));
  assert.ok(result.capabilities !== undefined && 'tools' in result.capabilities);
  assert.equal(result.serverInfo?.name, 'gitforge');
  assert.equal(result.serverInfo?.version, '0.1.0');
});

await test('initialize returns protocolVersion 2025-11-25 + serverInfo', async () => {
  const { status, rpc: rpcRes } = await rpc('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });
  assert.equal(status, 200);
  const result = rpcRes.result as { protocolVersion?: string; capabilities?: { tools?: unknown }; serverInfo?: { name?: string; version?: string } };
  assert.equal(result.protocolVersion, '2025-11-25');
  assert.ok(result.capabilities !== undefined && 'tools' in result.capabilities);
  assert.equal(result.serverInfo?.name, 'gitforge');
  assert.equal(result.serverInfo?.version, '0.1.0');
});

await test('notifications/initialized -> 202 empty body', async () => {
  const answer = await post('/mcp', { body: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, token: TOKEN });
  assert.equal(answer.status, 202);
  assert.equal(answer.text, '');
});

await test('tools/list: >=6 tools, six canonical names, schemas, byte-identical twice', async () => {
  const first = await post('/mcp', { body: { jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {} }, token: TOKEN });
  const second = await post('/mcp', { body: { jsonrpc: '2.0', id: 'list-2', method: 'tools/list', params: {} }, token: TOKEN });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstRpc = first.json as RpcResponse;
  const secondRpc = second.json as RpcResponse;
  const firstTools = (firstRpc.result as { tools?: unknown[] }).tools;
  const secondTools = (secondRpc.result as { tools?: unknown[] }).tools;
  assert.ok(Array.isArray(firstTools) && firstTools.length >= 6, `expected >=6 tools, got ${firstTools?.length}`);
  assert.equal(JSON.stringify(firstTools), JSON.stringify(secondTools), 'tools/list changed between calls');
  const names = (firstTools as Array<{ name?: string }>).map((t) => t.name);
  for (const canonical of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) {
    assert.ok(names.includes(canonical), `missing tool ${canonical}`);
  }
  for (const tool of firstTools as Array<{ name?: string; description?: string; inputSchema?: { type?: string } }>) {
    assert.equal(typeof tool.description, 'string');
    assert.ok((tool.description as string).trim().length > 0, `${tool.name}: empty description`);
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name}: inputSchema.type is not object`);
  }
});

await test('tools/call create_repo then get_repo round-trip', async () => {
  const created = await callTool('create_repo', { name: 'mcp-test-repo', description: 'a test repo', private: true });
  assert.equal(created.status, 200);
  assert.equal(isError(created.rpc), false);
  const createdJson = toolJson(created.rpc);
  assert.equal(createdJson.name, 'mcp-test-repo');
  assert.equal(createdJson.full_name, 'adaiversen/mcp-test-repo');
  assert.ok(toolText(created.rpc).includes('mcp-test-repo'));
  const got = await callTool('get_repo', { owner: 'adaiversen', repo: 'mcp-test-repo' });
  assert.equal(isError(got.rpc), false);
  assert.ok(toolText(got.rpc).includes('mcp-test-repo'));
  assert.equal(toolJson(got.rpc).default_branch, 'main');
  // REST parity: the same object lives in the Store.
  const repo = store.getRepo('adaiversen', 'mcp-test-repo');
  assert.ok(repo !== undefined);
  assert.equal(repo.description, 'a test repo');
  assert.equal(repo.private, true);
});

await test('tools/call create_issue then list_issues text contains the title', async () => {
  const created = await callTool('create_issue', { owner: 'adaiversen', repo: 'mcp-test-repo', title: 'MCP issue title', body: 'issue body' });
  assert.equal(isError(created.rpc), false);
  assert.equal(toolJson(created.rpc).number, 1);
  assert.equal(toolJson(created.rpc).state, 'open');
  const listed = await callTool('list_issues', { owner: 'adaiversen', repo: 'mcp-test-repo', state: 'open' });
  assert.equal(isError(listed.rpc), false);
  assert.ok(toolText(listed.rpc).includes('MCP issue title'), `list_issues text missing title: ${toolText(listed.rpc)}`);
  assert.ok(toolText(listed.rpc).includes('"number": 1') || toolText(listed.rpc).includes('"number":1'));
});

await test('tools/call create_pull_request then merge_pull_request -> merged true', async () => {
  const created = await callTool('create_repo', { name: 'mcp-pr-repo' });
  assert.equal(isError(created.rpc), false);
  const repo = store.getRepo('adaiversen', 'mcp-pr-repo');
  assert.ok(repo !== undefined);
  // Seed main + feature branches with real commit objects.
  const blobBase = makeBlob(repo, 'base\n');
  const treeBase = makeTree(repo, [{ mode: '100644', name: 'a.txt', oid: blobBase }]);
  const baseCommit = makeCommit(repo, treeBase, [], 'base commit');
  repo.refs.set('refs/heads/main', baseCommit);
  const blobHead = makeBlob(repo, 'feature\n');
  const treeHead = makeTree(repo, [{ mode: '100644', name: 'a.txt', oid: blobHead }]);
  const headCommit = makeCommit(repo, treeHead, [baseCommit], 'feature commit');
  repo.refs.set('refs/heads/feature', headCommit);

  const pr = await callTool('create_pull_request', { owner: 'adaiversen', repo: 'mcp-pr-repo', title: 'Add feature', head: 'feature', base: 'main', body: 'pr body' });
  assert.equal(isError(pr.rpc), false, toolText(pr.rpc));
  const prJson = toolJson(pr.rpc);
  assert.equal(prJson.number, 1);
  assert.equal((prJson.head as { ref?: string }).ref, 'feature');
  assert.equal((prJson.base as { ref?: string }).ref, 'main');

  const merged = await callTool('merge_pull_request', { owner: 'adaiversen', repo: 'mcp-pr-repo', pull_number: 1 });
  assert.equal(isError(merged.rpc), false, toolText(merged.rpc));
  const mergedJson = toolJson(merged.rpc);
  assert.equal(mergedJson.merged, true);
  assert.equal(mergedJson.state, 'closed');
  assert.equal(typeof mergedJson.sha, 'string');
  // The merge commit is on the base branch and carries the head bytes.
  const mergeSha = mergedJson.sha as string;
  assert.equal(repo.refs.get('refs/heads/main'), mergeSha);
  assert.equal(fileAtCommit(repo, mergeSha, 'a.txt'), 'feature\n');
  const pull = repo.pulls.get(1);
  assert.equal(pull?.merged, true);
  assert.equal(pull?.mergeCommitSha, mergeSha);
});

await test('create_pull_request with a missing head branch -> isError', async () => {
  const pr = await callTool('create_pull_request', { owner: 'adaiversen', repo: 'mcp-pr-repo', title: 'Nope', head: 'no-such-branch', base: 'main' });
  assert.equal(isError(pr.rpc), true);
  assert.ok(toolText(pr.rpc).includes('no-such-branch'));
});

await test('unknown tool -> -32601/-32602, never HTTP 500', async () => {
  const answer = await callTool('mcp_no_such_tool_xyz', {});
  assert.notEqual(answer.status, 500);
  assert.ok(answer.rpc.error !== undefined, 'expected a JSON-RPC error');
  assert.ok(answer.rpc.error.code === -32601 || answer.rpc.error.code === -32602, `unexpected code ${answer.rpc.error.code}`);
});

await test('create_issue with {} arguments -> isError true or -32602', async () => {
  const answer = await callTool('create_issue', {});
  const ok = isError(answer.rpc) || answer.rpc.error?.code === -32602;
  assert.ok(ok, `expected isError or -32602, got status ${answer.status} rpc ${JSON.stringify(answer.rpc)}`);
  if (isError(answer.rpc)) assert.ok(toolText(answer.rpc).includes('owner'), `error text should name a missing argument: ${toolText(answer.rpc)}`);
});

await test('non-JSON body -> HTTP 400 with -32700 and the readable id', async () => {
  const answer = await post('/mcp', { rawBody: '{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"', token: TOKEN });
  assert.equal(answer.status, 400);
  const rpcRes = answer.json as RpcResponse;
  assert.equal(rpcRes.error?.code, -32700);
  assert.equal(rpcRes.id, 424242);
});

await test('two concurrent get_repo calls keep their own string ids', async () => {
  await callTool('create_repo', { name: 'mcp-conc-left' });
  await callTool('create_repo', { name: 'mcp-conc-right' });
  const [left, right] = await Promise.all([
    callTool('get_repo', { owner: 'adaiversen', repo: 'mcp-conc-left' }, { id: 'conc-left-1' }),
    callTool('get_repo', { owner: 'adaiversen', repo: 'mcp-conc-right' }, { id: 'conc-right-1' }),
  ]);
  assert.equal(left.rpc.id, 'conc-left-1');
  assert.equal(right.rpc.id, 'conc-right-1');
  assert.ok(toolText(left.rpc).includes('mcp-conc-left'));
  assert.ok(toolText(right.rpc).includes('mcp-conc-right'));
});

await test('unknown method -> -32601', async () => {
  const { rpc: rpcRes } = await rpc('bogus/method', {});
  assert.equal(rpcRes.error?.code, -32601);
});

await test('get_repo for a missing repo -> isError, not an exception', async () => {
  const answer = await callTool('get_repo', { owner: 'adaiversen', repo: 'does-not-exist' });
  assert.equal(answer.status, 200);
  assert.equal(isError(answer.rpc), true);
});

await test('DELETE with Mcp-Session-Id -> 202 empty; GET /mcp -> 405', async () => {
  const del = await post('/mcp', { method: 'DELETE', token: TOKEN, headers: { 'mcp-session-id': 'sess-1' } });
  assert.equal(del.status, 202);
  assert.equal(del.text, '');
  const get = await post('/mcp', { method: 'GET', token: TOKEN });
  assert.equal(get.status, 405);
});

await test('extras: list_repos / get_issue / close_issue', async () => {
  const listed = await callTool('list_repos', {});
  assert.equal(isError(listed.rpc), false);
  assert.ok(toolText(listed.rpc).includes('mcp-test-repo'));
  const got = await callTool('get_issue', { owner: 'adaiversen', repo: 'mcp-test-repo', issue_number: 1 });
  assert.equal(isError(got.rpc), false);
  assert.equal(toolJson(got.rpc).title, 'MCP issue title');
  const closed = await callTool('close_issue', { owner: 'adaiversen', repo: 'mcp-test-repo', issue_number: 1 });
  assert.equal(isError(closed.rpc), false);
  assert.equal(toolJson(closed.rpc).state, 'closed');
  const relisted = await callTool('list_issues', { owner: 'adaiversen', repo: 'mcp-test-repo', state: 'open' });
  assert.ok(!toolText(relisted.rpc).includes('MCP issue title'), 'closed issue should not appear in open list');
});

await test('full_name alias resolves owner/repo', async () => {
  const got = await callTool('get_repo', { full_name: 'adaiversen/mcp-test-repo' });
  assert.equal(isError(got.rpc), false);
  assert.ok(toolText(got.rpc).includes('mcp-test-repo'));
});

// ---------------------------------------------------------------- report

server.close();
if (failures.length > 0) {
  console.log(`\n${passed} passed, ${failures.length} failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${passed} tests passed.`);
}
