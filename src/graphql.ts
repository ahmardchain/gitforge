// GraphQL v4 endpoint: small recursive-descent parser + executor +
// introspection. Node stdlib only, erasable TypeScript only.
// Tree diff / merge-base / squash-merge work reuses src/git-core.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { commitObject, diffTrees, mergeBase, parseCommit, readTreeRecursive, writeTreeRecursive } from './git-core.ts';
import { Store } from './store.ts';
import type { Issue, Pull, Repo } from './types.ts';
import { bearerToken, pathOf, readJsonBody, sendError, sendJson } from './http-util.ts';

// ---------------------------------------------------------------------------
// Lexer / parser for the GraphQL subset the suite uses
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Token { kind: TokenKind; value: string; }

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        const raw = end === -1 ? src.slice(i + 3) : src.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw.replace(/^\n/, '') });
        i = end === -1 ? n : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          if (e === 'u' && j + 5 < n) { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; continue; }
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
          out += map[e] ?? e;
          j += 2;
          continue;
        }
        out += src[j];
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) { isFloat = true; j += 1; while (j < n && /[0-9]/.test(src[j])) j += 1; }
      if (src[j] === 'e' || src[j] === 'E') { isFloat = true; j += 1; if (src[j] === '+' || src[j] === '-') j += 1; while (j < n && /[0-9]/.test(src[j])) j += 1; }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface TypeNode { kind: 'named' | 'list' | 'nonNull'; name?: string; ofType?: TypeNode; }
interface VarDef { name: string; type: TypeNode; defaultValue?: ValueNode; }
type Selection =
  | { kind: 'field'; alias: string | null; name: string; args: Array<{ name: string; value: ValueNode }>; selections: Selection[] }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: Selection[] };
interface Operation { kind: 'operation'; opType: 'query' | 'mutation' | 'subscription'; name: string | null; varDefs: VarDef[]; selections: Selection[]; }
interface FragmentDef { kind: 'fragment'; name: string; typeCondition: string; selections: Selection[]; }
type Definition = Operation | FragmentDef;
interface Document { definitions: Definition[]; }

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }
  private peek(): Token { return this.tokens[this.pos]; }
  private next(): Token { return this.tokens[this.pos++]; }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`Expected '${v}' but got '${t.value}'`);
  }
  private expectName(what = 'name'): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected ${what} but got '${t.value}'`);
    return t.value;
  }
  private matchPunct(v: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === v) { this.pos += 1; return true; }
    return false;
  }
  parseDocument(): Document {
    const definitions: Definition[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return { definitions };
  }
  private parseDefinition(): Definition {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', opType: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName('fragment name');
      const on = this.expectName("'on'");
      if (on !== 'on') throw new Error(`Expected 'on' in fragment definition`);
      const typeCondition = this.expectName('fragment type condition');
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      const opType = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const varDefs = this.parseVarDefs();
      return { kind: 'operation', opType, name, varDefs, selections: this.parseSelectionSet() };
    }
    throw new Error(`Unexpected token '${t.value}' in GraphQL document`);
  }
  private parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    if (!this.matchPunct('(')) return defs;
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName('variable name');
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.matchPunct('=')) defaultValue = this.parseValue(true);
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }
  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.matchPunct('[')) {
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', ofType: inner };
    } else {
      type = { kind: 'named', name: this.expectName('type name') };
    }
    if (this.matchPunct('!')) type = { kind: 'nonNull', ofType: type };
    return type;
  }
  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (!this.matchPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set');
      sels.push(this.parseSelection());
    }
    return sels;
  }
  private parseSelection(): Selection {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('inline fragment type');
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('field name');
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) { alias = first; name = this.expectName('field name'); }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        const argName = this.expectName('argument name');
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue(false) });
      }
    }
    // Directives are not used by the suite; skip any @...(...) if present.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('directive name');
      if (this.matchPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const tok = this.next();
          if (tok.kind === 'punct' && tok.value === '(') depth += 1;
          if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
          if (tok.kind === 'eof') break;
        }
      }
    }
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }
  private parseValue(isConst: boolean): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      if (isConst) throw new Error('Variable in constant value');
      return { kind: 'variable', name: this.expectName('variable name') };
    }
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue(isConst));
      this.next();
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName('input field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected value token '${t.value}'`);
  }
}

function parseDocument(query: string): Document {
  return new Parser(lex(query)).parseDocument();
}

// ---------------------------------------------------------------------------
// Introspection tables
// ---------------------------------------------------------------------------

interface FieldDef { name: string; type: string; }
interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'INTERFACE' | 'SCALAR';
  fields: FieldDef[];
  enumValues: string[];
  inputFields: FieldDef[];
}

function f(name: string, type: string): FieldDef { return { name, type }; }

const TYPES: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: [f('viewer', 'User'), f('repository', 'Repository'), f('node', 'Node'), f('__type', '__Type'), f('__schema', '__Schema')], enumValues: [], inputFields: [] },
  Mutation: { kind: 'OBJECT', fields: [f('createIssue', 'CreateIssuePayload'), f('closeIssue', 'CloseIssuePayload'), f('createPullRequest', 'CreatePullRequestPayload'), f('mergePullRequest', 'MergePullRequestPayload'), f('addComment', 'AddCommentPayload')], enumValues: [], inputFields: [] },
  User: { kind: 'OBJECT', fields: [f('login', 'String'), f('id', 'ID'), f('name', 'String')], enumValues: [], inputFields: [] },
  Repository: { kind: 'OBJECT', fields: [f('id', 'ID'), f('databaseId', 'Int'), f('name', 'String'), f('nameWithOwner', 'String'), f('owner', 'User'), f('defaultBranchRef', 'Ref'), f('viewerPermission', 'RepositoryPermission'), f('hasIssuesEnabled', 'Boolean'), f('issue', 'Issue'), f('issues', 'IssueConnection'), f('pullRequests', 'PullRequestConnection'), f('pullRequest', 'PullRequest'), f('description', 'String'), f('private', 'Boolean')], enumValues: [], inputFields: [] },
  Ref: { kind: 'OBJECT', fields: [f('name', 'String'), f('id', 'ID')], enumValues: [], inputFields: [] },
  Issue: { kind: 'OBJECT', fields: [f('id', 'ID'), f('number', 'Int'), f('title', 'String'), f('state', 'IssueState'), f('body', 'String'), f('author', 'User'), f('createdAt', 'String')], enumValues: [], inputFields: [] },
  IssueConnection: { kind: 'OBJECT', fields: [f('nodes', 'Issue'), f('pageInfo', 'PageInfo'), f('totalCount', 'Int')], enumValues: [], inputFields: [] },
  PullRequest: { kind: 'OBJECT', fields: [f('id', 'ID'), f('number', 'Int'), f('title', 'String'), f('state', 'PullRequestState'), f('merged', 'Boolean'), f('headRefName', 'String'), f('baseRefName', 'String'), f('mergeable', 'MergeableState'), f('files', 'PullRequestChangedFileConnection'), f('body', 'String')], enumValues: [], inputFields: [] },
  PullRequestConnection: { kind: 'OBJECT', fields: [f('nodes', 'PullRequest'), f('pageInfo', 'PageInfo'), f('totalCount', 'Int')], enumValues: [], inputFields: [] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: [f('nodes', 'PullRequestChangedFile'), f('pageInfo', 'PageInfo')], enumValues: [], inputFields: [] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: [f('path', 'String')], enumValues: [], inputFields: [] },
  PageInfo: { kind: 'OBJECT', fields: [f('hasNextPage', 'Boolean'), f('hasPreviousPage', 'Boolean'), f('startCursor', 'String'), f('endCursor', 'String')], enumValues: [], inputFields: [] },
  IssueOrder: { kind: 'INPUT_OBJECT', fields: [f('field', 'IssueOrderField'), f('direction', 'OrderDirection')], enumValues: [], inputFields: [f('field', 'IssueOrderField'), f('direction', 'OrderDirection')] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], inputFields: [] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'], inputFields: [] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'], inputFields: [] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], inputFields: [] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'], inputFields: [] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'], inputFields: [] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], inputFields: [] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'], inputFields: [] },
  Node: { kind: 'INTERFACE', fields: [f('id', 'ID')], enumValues: [], inputFields: [] },
  CreateIssueInput: { kind: 'INPUT_OBJECT', fields: [f('repositoryId', 'ID'), f('title', 'String'), f('body', 'String'), f('clientMutationId', 'String')], enumValues: [], inputFields: [f('repositoryId', 'ID'), f('title', 'String'), f('body', 'String'), f('clientMutationId', 'String')] },
  CloseIssueInput: { kind: 'INPUT_OBJECT', fields: [f('issueId', 'ID'), f('clientMutationId', 'String')], enumValues: [], inputFields: [f('issueId', 'ID'), f('clientMutationId', 'String')] },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT', fields: [f('repositoryId', 'ID'), f('baseRefName', 'String'), f('headRefName', 'String'), f('title', 'String'), f('body', 'String'), f('clientMutationId', 'String')], enumValues: [], inputFields: [f('repositoryId', 'ID'), f('baseRefName', 'String'), f('headRefName', 'String'), f('title', 'String'), f('body', 'String'), f('clientMutationId', 'String')] },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', fields: [f('pullRequestId', 'ID'), f('mergeMethod', 'PullRequestMergeMethod'), f('clientMutationId', 'String')], enumValues: [], inputFields: [f('pullRequestId', 'ID'), f('mergeMethod', 'PullRequestMergeMethod'), f('clientMutationId', 'String')] },
  AddCommentInput: { kind: 'INPUT_OBJECT', fields: [f('subjectId', 'ID'), f('body', 'String'), f('clientMutationId', 'String')], enumValues: [], inputFields: [f('subjectId', 'ID'), f('body', 'String'), f('clientMutationId', 'String')] },
  CreateIssuePayload: { kind: 'OBJECT', fields: [f('issue', 'Issue'), f('clientMutationId', 'String')], enumValues: [], inputFields: [] },
  CloseIssuePayload: { kind: 'OBJECT', fields: [f('issue', 'Issue'), f('clientMutationId', 'String')], enumValues: [], inputFields: [] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: [f('pullRequest', 'PullRequest'), f('clientMutationId', 'String')], enumValues: [], inputFields: [] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: [f('pullRequest', 'PullRequest'), f('clientMutationId', 'String')], enumValues: [], inputFields: [] },
  AddCommentPayload: { kind: 'OBJECT', fields: [f('commentEdge', 'IssueCommentEdge'), f('subject', 'Issue'), f('clientMutationId', 'String')], enumValues: [], inputFields: [] },
  IssueCommentEdge: { kind: 'OBJECT', fields: [f('node', 'IssueComment'), f('cursor', 'String')], enumValues: [], inputFields: [] },
  IssueComment: { kind: 'OBJECT', fields: [f('id', 'ID'), f('body', 'String')], enumValues: [], inputFields: [] },
  __Schema: { kind: 'OBJECT', fields: [f('types', '__Type'), f('queryType', '__Type'), f('mutationType', '__Type'), f('description', 'String')], enumValues: [], inputFields: [] },
  __Type: { kind: 'OBJECT', fields: [f('kind', 'String'), f('name', 'String'), f('description', 'String'), f('fields', '__Field'), f('enumValues', '__EnumValue'), f('inputFields', '__InputValue'), f('interfaces', '__Type'), f('possibleTypes', '__Type'), f('ofType', '__Type')], enumValues: [], inputFields: [] },
  __Field: { kind: 'OBJECT', fields: [f('name', 'String'), f('description', 'String'), f('args', '__InputValue'), f('type', '__Type'), f('isDeprecated', 'Boolean'), f('deprecationReason', 'String')], enumValues: [], inputFields: [] },
  __EnumValue: { kind: 'OBJECT', fields: [f('name', 'String'), f('description', 'String'), f('isDeprecated', 'Boolean'), f('deprecationReason', 'String')], enumValues: [], inputFields: [] },
  __InputValue: { kind: 'OBJECT', fields: [f('name', 'String'), f('description', 'String'), f('type', '__Type'), f('defaultValue', 'String')], enumValues: [], inputFields: [] },
  String: { kind: 'SCALAR', fields: [], enumValues: [], inputFields: [] },
  Int: { kind: 'SCALAR', fields: [], enumValues: [], inputFields: [] },
  Boolean: { kind: 'SCALAR', fields: [], enumValues: [], inputFields: [] },
  ID: { kind: 'SCALAR', fields: [], enumValues: [], inputFields: [] },
};

// ---------------------------------------------------------------------------
// Git helpers built on src/git-core.ts (diff / merge-base / tree writes)
// ---------------------------------------------------------------------------

function commitTreeOid(repo: Repo, commitOid: string | null): string | null {
  if (!commitOid) return null;
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  try {
    return parseCommit(obj.data).tree || null;
  } catch {
    return null;
  }
}

function makeMergeCommit(repo: Repo, tree: string, parents: string[], message: string, epoch: number): string {
  const who = `adaiversen <adaiversen@example.invalid> ${epoch} +0000`;
  return commitObject(repo.objects, { tree, parents, author: who, committer: who, message });
}

/** Dry-run a squash merge: does head-vs-merge-base apply cleanly onto base? */
function squashPlan(repo: Repo, pull: Pull): { conflict: boolean; changes: Map<string, Buffer | null> } {
  const changes = new Map<string, Buffer | null>();
  if (!pull.headSha || !pull.baseSha) return { conflict: false, changes };
  const mb = mergeBase(repo.objects, pull.headSha, pull.baseSha);
  const mbTree = mb ? commitTreeOid(repo, mb) : null;
  const headTree = commitTreeOid(repo, pull.headSha);
  const baseTree = commitTreeOid(repo, pull.baseSha);
  const headDiff = diffTrees(repo.objects, mbTree, headTree);
  const baseDiff = diffTrees(repo.objects, mbTree, baseTree);
  const baseByPath = new Map(baseDiff.map((d) => [d.path, d]));
  for (const d of headDiff) {
    const b = baseByPath.get(d.path);
    if (b && b.newOid !== d.newOid) return { conflict: true, changes };
  }
  const headFlat = headTree ? readTreeRecursive(repo.objects, headTree) : new Map<string, { oid: string; mode: string }>();
  for (const d of headDiff) {
    if (d.status === 'deleted') changes.set(d.path, null);
    else {
      const entry = headFlat.get(d.path);
      const obj = entry ? repo.objects.get(entry.oid) : undefined;
      if (obj) changes.set(d.path, obj.data);
    }
  }
  return { conflict: false, changes };
}

function mergeableOf(repo: Repo, pull: Pull): string {
  if (!pull.headSha || !pull.baseSha) return 'UNKNOWN';
  return squashPlan(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function prFilePaths(repo: Repo, pull: Pull): string[] {
  if (!pull.headSha) return [];
  const mb = pull.baseSha ? mergeBase(repo.objects, pull.headSha, pull.baseSha) : null;
  const mbTree = mb ? commitTreeOid(repo, mb) : null;
  const headTree = commitTreeOid(repo, pull.headSha);
  return diffTrees(repo.objects, mbTree, headTree).map((d) => d.path);
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class GQLError extends Error {}

type NodeVal = { __typename: string; [key: string]: unknown };

function nodeVal(typename: string, data: Record<string, unknown>): NodeVal {
  return { __typename: typename, ...data };
}

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string }>;
}

function evalValue(v: ValueNode, ctx: ExecCtx): unknown {
  switch (v.kind) {
    case 'variable': {
      if (Object.prototype.hasOwnProperty.call(ctx.variables, v.name)) return ctx.variables[v.name];
      return undefined;
    }
    case 'int': case 'float': case 'string': case 'boolean': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.values.map((x) => evalValue(x, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = evalValue(f.value, ctx);
      return out;
    }
  }
}

function resolveVariables(op: Operation, bodyVars: Record<string, unknown>): Record<string, unknown> {
  const vars: Record<string, unknown> = { ...bodyVars };
  const tmpCtx: ExecCtx = { store: null as unknown as Store, variables: bodyVars, fragments: new Map(), errors: [] };
  for (const def of op.varDefs) {
    if (vars[def.name] === undefined && def.defaultValue !== undefined) {
      vars[def.name] = evalValue(def.defaultValue, tmpCtx);
    }
  }
  return vars;
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function findRepoByGlobalId(store: Store, gid: string): Repo | undefined {
  const parsed = store.parseGlobalId(gid);
  if (!parsed || parsed.kind !== 'Repository' || parsed.parts.length < 1) return undefined;
  return findRepoById(store, Number(parsed.parts[0]));
}

function findIssueByGlobalId(store: Store, gid: string): { repo: Repo; issue: Issue } | undefined {
  const parsed = store.parseGlobalId(gid);
  if (!parsed || parsed.kind !== 'Issue' || parsed.parts.length < 2) return undefined;
  const repo = findRepoById(store, Number(parsed.parts[0]));
  if (!repo) return undefined;
  const issue = repo.issues.get(Number(parsed.parts[1]));
  return issue ? { repo, issue } : undefined;
}

function findPullByGlobalId(store: Store, gid: string): { repo: Repo; pull: Pull } | undefined {
  const parsed = store.parseGlobalId(gid);
  if (!parsed || parsed.kind !== 'PullRequest' || parsed.parts.length < 2) return undefined;
  const repo = findRepoById(store, Number(parsed.parts[0]));
  if (!repo) return undefined;
  const pull = repo.pulls.get(Number(parsed.parts[1]));
  return pull ? { repo, pull } : undefined;
}

function repoNode(store: Store, repo: Repo): NodeVal {
  return nodeVal('Repository', { repo, id: store.globalId('Repository', repo.id) });
}
function issueNode(repo: Repo, issue: Issue): NodeVal {
  return nodeVal('Issue', { repo, issue });
}
function pullNode(repo: Repo, pull: Pull, forceState?: string, forceMerged?: boolean): NodeVal {
  return nodeVal('PullRequest', { repo, pull, forceState, forceMerged });
}
function userNode(store: Store, login: string): NodeVal {
  return nodeVal('User', { login, id: store.globalId('User', login === store.viewerLogin ? store.viewerId : 0) });
}

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`).toString('base64url');
}
function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    if (m) return parseInt(m[1], 10);
    const n = parseInt(text, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function typeNodeFor(name: string): NodeVal {
  const def = TYPES[name];
  const kind = def ? def.kind : 'OBJECT';
  return nodeVal('__Type', { typeName: name, kind, fields: def ? def.fields : [], enumValues: def ? def.enumValues : [], inputFields: def ? def.inputFields : [] });
}

function allowedFields(typeName: string): Set<string> {
  const def = TYPES[typeName];
  const set = new Set<string>(['__typename']);
  if (def) for (const f of def.fields) set.add(f.name);
  if (typeName === 'Query') { set.add('__type'); set.add('__schema'); }
  if (typeName === '__Type') { set.add('fields'); set.add('enumValues'); set.add('inputFields'); }
  return set;
}

function executeSelections(ctx: ExecCtx, parentType: string, parent: NodeVal | null, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) throw new GQLError(`Unknown fragment "${sel.name}"`);
      if (frag.typeCondition === parentType || frag.typeCondition === 'Node') {
        Object.assign(out, executeSelections(ctx, parentType, parent, frag.selections));
      }
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (!sel.typeCondition || sel.typeCondition === parentType || sel.typeCondition === 'Node') {
        Object.assign(out, executeSelections(ctx, parentType, parent, sel.selections));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') { out[key] = parentType; continue; }
    if (!allowedFields(parentType).has(sel.name)) {
      throw new GQLError(`Cannot query field "${sel.name}" on type "${parentType}".`);
    }
    const args: Record<string, unknown> = {};
    for (const a of sel.args) args[a.name] = evalValue(a.value, ctx);
    const value = resolveField(ctx, parentType, parent, sel.name, args);
    out[key] = completeValue(ctx, parentType, sel.name, value, sel.selections);
  }
  return out;
}

function completeValue(ctx: ExecCtx, parentType: string, fieldName: string, value: unknown, selections: Selection[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => completeValue(ctx, parentType, fieldName, v, selections));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    const nv = value as NodeVal;
    if (selections.length === 0) return nv;
    return executeSelections(ctx, nv.__typename, nv, selections);
  }
  return value;
}

function fieldTypeOf(parentType: string, fieldName: string): string {
  const def = TYPES[parentType];
  return def?.fields.find((f) => f.name === fieldName)?.type ?? 'String';
}

function resolveField(ctx: ExecCtx, parentType: string, parent: NodeVal | null, fieldName: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  // Root Query
  if (parentType === 'Query') {
    if (fieldName === 'viewer') return userNode(store, store.viewerLogin);
    if (fieldName === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== store.viewerLogin) return null;
      const repo = store.getRepo(owner, name);
      return repo ? repoNode(store, repo) : null;
    }
    if (fieldName === 'node') {
      const id = args.id as string;
      if (typeof id !== 'string') return null;
      const parsed = store.parseGlobalId(id);
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = findRepoById(store, Number(parsed.parts[0]));
        return repo ? repoNode(store, repo) : null;
      }
      if (parsed.kind === 'Issue') {
        const found = findIssueByGlobalId(store, id);
        return found ? issueNode(found.repo, found.issue) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const found = findPullByGlobalId(store, id);
        return found ? pullNode(found.repo, found.pull) : null;
      }
      return null;
    }
    if (fieldName === '__type') {
      const name = args.name as string;
      if (typeof name !== 'string' || !TYPES[name]) return null;
      return typeNodeFor(name);
    }
    if (fieldName === '__schema') {
      return nodeVal('__Schema', { typeNames: Object.keys(TYPES) });
    }
    throw new GQLError(`Cannot query field "${fieldName}" on type "Query".`);
  }
  // Root Mutation
  if (parentType === 'Mutation') return resolveMutation(ctx, fieldName, args);
  if (parent === null) return null;

  switch (parentType) {
    case 'User': {
      if (fieldName === 'login') return parent.login as string;
      if (fieldName === 'id') return parent.id as string;
      if (fieldName === 'name') return parent.login as string;
      break;
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      switch (fieldName) {
        case 'id': return parent.id as string;
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return userNode(store, repo.owner);
        case 'defaultBranchRef': {
          const head = store.headOid(repo);
          return head ? nodeVal('Ref', { name: repo.defaultBranch, id: store.globalId('Ref', repo.id, repo.defaultBranch) }) : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'private': return repo.private;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? issueNode(repo, issue) : null;
        }
        case 'issues': return issuesConnection(repo, args);
        case 'pullRequests': return pullsConnection(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? pullNode(repo, pull) : null;
        }
      }
      break;
    }
    case 'Ref': {
      if (fieldName === 'name') return parent.name as string;
      if (fieldName === 'id') return parent.id as string;
      break;
    }
    case 'Issue': {
      const issue = parent.issue as Issue;
      switch (fieldName) {
        case 'id': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
        case 'author': return userNode(store, store.viewerLogin);
        case 'createdAt': return store.nowIso();
      }
      break;
    }
    case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestChangedFileConnection': {
      if (fieldName === 'nodes') return (parent.nodes as unknown[]) ?? [];
      if (fieldName === 'pageInfo') return parent.pageInfo as NodeVal;
      if (fieldName === 'totalCount') return (parent.nodes as unknown[] ?? []).length;
      break;
    }
    case 'PageInfo': {
      if (fieldName === 'hasNextPage') return parent.hasNextPage as boolean;
      if (fieldName === 'hasPreviousPage') return false;
      if (fieldName === 'startCursor') return (parent.startCursor as string | null) ?? null;
      if (fieldName === 'endCursor') return (parent.endCursor as string | null) ?? null;
      break;
    }
    case 'PullRequest': {
      const pull = parent.pull as Pull;
      const repo = parent.repo as Repo;
      switch (fieldName) {
        case 'id': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'state': {
          if (typeof parent.forceState === 'string') return parent.forceState;
          if (pull.merged) return 'MERGED';
          return pull.state === 'open' ? 'OPEN' : 'CLOSED';
        }
        case 'merged': return typeof parent.forceMerged === 'boolean' ? parent.forceMerged : pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return mergeableOf(repo, pull);
        case 'body': return pull.body;
        case 'files': {
          const paths = prFilePaths(repo, pull);
          const first = typeof args.first === 'number' ? args.first : paths.length;
          const nodes = paths.slice(0, first).map((p) => nodeVal('PullRequestChangedFile', { path: p }));
          return nodeVal('PullRequestChangedFileConnection', {
            nodes,
            pageInfo: nodeVal('PageInfo', { hasNextPage: paths.length > first, startCursor: null, endCursor: null }),
          });
        }
      }
      break;
    }
    case 'PullRequestChangedFile': {
      if (fieldName === 'path') return parent.path as string;
      break;
    }
    case 'CreateIssuePayload': case 'CloseIssuePayload': {
      if (fieldName === 'issue') return parent.issue as NodeVal;
      if (fieldName === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload': case 'MergePullRequestPayload': {
      if (fieldName === 'pullRequest') return parent.pullRequest as NodeVal;
      if (fieldName === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      if (fieldName === 'commentEdge') return parent.commentEdge as NodeVal;
      if (fieldName === 'subject') return parent.subject as NodeVal | null;
      if (fieldName === 'clientMutationId') return null;
      break;
    }
    case 'IssueCommentEdge': {
      if (fieldName === 'node') return parent.node as NodeVal;
      if (fieldName === 'cursor') return null;
      break;
    }
    case 'IssueComment': {
      if (fieldName === 'id') return parent.id as string;
      if (fieldName === 'body') return parent.body as string;
      break;
    }
    case '__Type': {
      const typeName = parent.typeName as string;
      const def = TYPES[typeName];
      switch (fieldName) {
        case 'kind': return parent.kind as string;
        case 'name': return typeName;
        case 'description': return null;
        case 'fields': {
          const list = def ? def.fields : [];
          return list.map((fd) => nodeVal('__Field', { name: fd.name, typeName: fd.type }));
        }
        case 'enumValues': {
          const list = def ? def.enumValues : [];
          return list.map((n) => nodeVal('__EnumValue', { name: n }));
        }
        case 'inputFields': {
          const list = def ? def.inputFields : [];
          return list.map((fd) => nodeVal('__InputValue', { name: fd.name, typeName: fd.type }));
        }
        case 'interfaces': return [];
        case 'possibleTypes': return [];
        case 'ofType': return null;
      }
      break;
    }
    case '__Schema': {
      if (fieldName === 'types') return (parent.typeNames as string[]).map((n) => typeNodeFor(n));
      if (fieldName === 'queryType') return typeNodeFor('Query');
      if (fieldName === 'mutationType') return typeNodeFor('Mutation');
      if (fieldName === 'description') return null;
      break;
    }
    case '__Field': {
      if (fieldName === 'name') return parent.name as string;
      if (fieldName === 'description') return null;
      if (fieldName === 'args') return [];
      if (fieldName === 'type') return typeNodeFor(stripTypeName(parent.typeName as string));
      if (fieldName === 'isDeprecated') return false;
      if (fieldName === 'deprecationReason') return null;
      break;
    }
    case '__EnumValue': {
      if (fieldName === 'name') return parent.name as string;
      if (fieldName === 'description') return null;
      if (fieldName === 'isDeprecated') return false;
      if (fieldName === 'deprecationReason') return null;
      break;
    }
    case '__InputValue': {
      if (fieldName === 'name') return parent.name as string;
      if (fieldName === 'description') return null;
      if (fieldName === 'type') return typeNodeFor(stripTypeName(parent.typeName as string));
      if (fieldName === 'defaultValue') return null;
      break;
    }
  }
  throw new GQLError(`Cannot query field "${fieldName}" on type "${parentType}".`);
}

function stripTypeName(t: string): string {
  return t.replace(/[\[\]!]/g, '');
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): NodeVal {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const direction = orderBy && typeof orderBy.direction === 'string' ? String(orderBy.direction) : 'ASC';
  const desc = direction === 'DESC';
  list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const start = decodeCursor(args.after);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const endIndex = start + page.length;
  const hasNextPage = endIndex < list.length;
  return nodeVal('IssueConnection', {
    nodes: page.map((i) => issueNode(repo, i)),
    pageInfo: nodeVal('PageInfo', {
      hasNextPage,
      startCursor: page.length > 0 ? encodeCursor(start) : null,
      endCursor: page.length > 0 ? encodeCursor(endIndex) : null,
    }),
  });
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): NodeVal {
  let list = [...repo.pulls.values()];
  list.sort((a, b) => a.number - b.number);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return nodeVal('PullRequestConnection', {
    nodes: page.map((p) => pullNode(repo, p)),
    pageInfo: nodeVal('PageInfo', { hasNextPage: list.length > first, startCursor: null, endCursor: null }),
  });
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function resolveMutation(ctx: ExecCtx, fieldName: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  const input = asRecord(args.input);
  if (fieldName === 'createIssue') {
    const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(store, input.repositoryId) : undefined;
    if (!repo) throw new GQLError('Repository not found for createIssue');
    const issue = store.nextIssueId(repo);
    issue.title = typeof input.title === 'string' ? input.title : '';
    issue.body = typeof input.body === 'string' ? input.body : '';
    repo.issues.set(issue.number, issue);
    return nodeVal('CreateIssuePayload', { issue: issueNode(repo, issue) });
  }
  if (fieldName === 'closeIssue') {
    const found = typeof input.issueId === 'string' ? findIssueByGlobalId(store, input.issueId) : undefined;
    if (!found) throw new GQLError('Issue not found for closeIssue');
    found.issue.state = 'closed';
    return nodeVal('CloseIssuePayload', { issue: issueNode(found.repo, found.issue) });
  }
  if (fieldName === 'createPullRequest') {
    const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(store, input.repositoryId) : undefined;
    if (!repo) throw new GQLError('Repository not found for createPullRequest');
    const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
    const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const pull = store.nextPullId(repo);
    pull.title = typeof input.title === 'string' ? input.title : '';
    pull.body = typeof input.body === 'string' ? input.body : '';
    pull.headRef = headRef;
    pull.baseRef = baseRef;
    pull.headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
    pull.baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
    repo.pulls.set(pull.number, pull);
    return nodeVal('CreatePullRequestPayload', { pullRequest: pullNode(repo, pull) });
  }
  if (fieldName === 'mergePullRequest') {
    const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(store, input.pullRequestId) : undefined;
    if (!found) throw new GQLError('Pull request not found for mergePullRequest');
    const { repo, pull } = found;
    if (pull.merged) {
      return nodeVal('MergePullRequestPayload', { pullRequest: pullNode(repo, pull, 'CLOSED', true) });
    }
    const plan = squashPlan(repo, pull);
    if (plan.conflict) {
      ctx.errors.push({ message: `Merge conflict in pull request #${pull.number}` });
      return nodeVal('MergePullRequestPayload', { pullRequest: pullNode(repo, pull, 'OPEN', false) });
    }
    const baseTree = commitTreeOid(repo, pull.baseSha || null);
    const newTree = writeTreeRecursive(repo.objects, baseTree, plan.changes);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const mergeCommit = makeMergeCommit(repo, newTree, pull.baseSha ? [pull.baseSha] : [], message, store.nowSec());
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = store.nowIso();
    pull.mergeCommitSha = mergeCommit;
    return nodeVal('MergePullRequestPayload', { pullRequest: pullNode(repo, pull, 'CLOSED', true) });
  }
  if (fieldName === 'addComment') {
    const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
    const found = findIssueByGlobalId(store, subjectId);
    if (!found) throw new GQLError('Subject not found for addComment');
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = store.nextCommentId(found.repo, found.issue.number, body);
    found.repo.comments.set(comment.id, comment);
    const node = nodeVal('IssueComment', { id: store.globalId('IssueComment', found.repo.id, comment.id), body });
    return nodeVal('AddCommentPayload', {
      commentEdge: nodeVal('IssueCommentEdge', { node }),
      subject: issueNode(found.repo, found.issue),
    });
  }
  throw new GQLError(`Cannot query field "${fieldName}" on type "Mutation".`);
}

function executeOperation(store: Store, doc: Document, body: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  const query = body.query;
  if (typeof query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
  let parsed: Document;
  try {
    parsed = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Failed to parse GraphQL document' }] };
  }
  void doc;
  const fragments = new Map<string, FragmentDef>();
  const operations: Operation[] = [];
  for (const def of parsed.definitions) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
    else operations.push(def);
  }
  const variables = (body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables))
    ? (body.variables as Record<string, unknown>) : {};
  let op: Operation | undefined;
  const opName = typeof body.operationName === 'string' ? body.operationName : undefined;
  if (opName) op = operations.find((o) => o.name === opName);
  else if (operations.length === 1) op = operations[0];
  else op = operations.find((o) => o.name === null) ?? operations[0];
  if (!op) return { data: null, errors: [{ message: 'No operation found in GraphQL document' }] };
  if (op.opType === 'subscription') return { data: null, errors: [{ message: 'Subscriptions are not supported' }] };
  const ctx: ExecCtx = { store, variables: resolveVariables(op, variables), fragments, errors };
  const rootType = op.opType === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind !== 'field') {
      // Top-level fragments are not used by the suite; expand them if present.
      try {
        const expanded = sel.kind === 'fragmentSpread'
          ? (fragments.get(sel.name)?.selections ?? [])
          : sel.selections;
        Object.assign(data, executeSelections(ctx, rootType, null, expanded));
      } catch (err) {
        errors.push({ message: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    try {
      if (sel.name === '__typename') { data[key] = rootType; continue; }
      if (!allowedFields(rootType).has(sel.name)) {
        throw new GQLError(`Cannot query field "${sel.name}" on type "${rootType}".`);
      }
      const args: Record<string, unknown> = {};
      for (const a of sel.args) args[a.name] = evalValue(a.value, ctx);
      const value = resolveField(ctx, rootType, null, sel.name, args);
      data[key] = completeValue(ctx, rootType, sel.name, value, sel.selections);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      data[key] = null;
    }
  }
  if (errors.length > 0) return { data, errors };
  return { data };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleGraphql(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/api/graphql') return false;
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method not allowed');
    return true;
  }
  const token = bearerToken(req);
  if (!token || token !== store.token) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) {
    sendError(res, 400, parsedBody.error ?? 'malformed JSON body');
    return true;
  }
  const body = parsedBody.value;
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      const rec = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
      return executeOperation(store, { definitions: [] }, rec);
    });
    sendJson(res, 200, results);
    return true;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 400, 'GraphQL body must be an object or an array');
    return true;
  }
  const result = executeOperation(store, { definitions: [] }, body as Record<string, unknown>);
  sendJson(res, 200, result);
  return true;
}
