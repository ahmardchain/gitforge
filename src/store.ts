// The single source of truth for every surface: REST, GraphQL, MCP and
// git smart HTTP all read and write this one in-memory store. Nothing is
// written to disk per request; the trial pod is fresh for every trial, so
// in-memory state is the store.

import { isoTime, trialNowSec, type Issue, type IssueComment, type Label, type Milestone, type Pull, type Repo } from './types.ts';

export class Store {
  /** The login of the bearer token's owner. The suite's scenario is built
   * from one fixed seed, so the viewer is this login in every trial. */
  readonly viewerLogin = 'adaiversen';
  readonly viewerId = 1000;
  readonly viewerEmail = 'adaiversen@example.invalid';

  /** The bearer token this process was given; the suite presents it. */
  readonly token: string | null = process.env.MAKEFUN_SHOP_TOKEN ?? null;

  readonly repos = new Map<string, Repo>();
  nextRepoId = 1;
  seq = 0;
  private readonly baseEpoch = trialNowSec();

  /** Deterministic "now" in whole seconds. */
  nowSec(): number {
    return this.baseEpoch;
  }

  /** Deterministic "now" as an ISO timestamp. */
  nowIso(): string {
    return isoTime(this.baseEpoch);
  }

  /** Next value of the global monotonic sequence (creation order). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Opaque, stable global id, e.g. base64url("Repository:12"). */
  globalId(kind: string, ...parts: Array<string | number>): string {
    return Buffer.from([kind, ...parts.map(String)].join(':')).toString('base64url');
  }

  /** Decode a global id back into its kind and parts, or null. */
  parseGlobalId(id: string): { kind: string; parts: string[] } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      const parts = text.split(':');
      if (parts.length < 2) return null;
      return { kind: parts[0], parts: parts.slice(1) };
    } catch {
      return null;
    }
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean } = {}): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
      labels: new Map(),
      comments: new Map(),
      nextComment: 1,
      milestones: new Map(),
      nextMilestone: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Oid of the default branch tip, or null when the repo is unborn. */
  headOid(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** The viewer's repos in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewerLogin) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  nextIssueId(repo: Repo): Issue {
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    return {
      id: this.globalId('Issue', repo.id, number),
      number,
      title: '',
      body: '',
      state: 'open',
      labels: [],
      createdSeq: this.nextSeq(),
    };
  }

  nextPullId(repo: Repo): Pull {
    const number = repo.nextPull;
    repo.nextPull += 1;
    return {
      id: this.globalId('PullRequest', repo.id, number),
      number,
      title: '',
      body: '',
      state: 'open',
      merged: false,
      mergeable: 'UNKNOWN',
      headRef: '',
      baseRef: '',
      headSha: '',
      baseSha: '',
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
  }

  nextCommentId(repo: Repo, issueNumber: number, body: string): IssueComment {
    const id = repo.nextComment;
    repo.nextComment += 1;
    return { id, issueNumber, body, createdSeq: this.nextSeq() };
  }

  nextMilestoneId(repo: Repo, title: string): Milestone {
    const number = repo.nextMilestone;
    repo.nextMilestone += 1;
    return { id: number, number, title, state: 'open' };
  }

  newLabel(name: string, color: string): Label {
    return { name, color };
  }
}
