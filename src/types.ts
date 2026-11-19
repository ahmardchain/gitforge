// Shared types for gitforge, plus the deterministic clock.
//
// Determinism rule: no wall clock and no unseeded randomness in stored
// data. Every timestamp the forge emits comes from trialNowSec() —
// MAKEFUN_TRIAL_NOW when the trial sets it, else a fixed epoch — and
// ordering comes from a monotonic sequence number. Two runs of the same
// request sequence therefore produce identical responses.

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
}

export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  issueNumber: number;
  body: string;
  createdSeq: number;
}

export interface Milestone {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  labels: Map<string, Label>;
  comments: Map<number, IssueComment>;
  nextComment: number;
  milestones: Map<number, Milestone>;
  nextMilestone: number;
}

/** The trial's fixed "now" in whole seconds. MAKEFUN_TRIAL_NOW is set by
 * the trial harness; values above 1e12 are milliseconds. Falls back to a
 * fixed epoch so local runs are deterministic too. */
export function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n > 1e12 ? n / 1000 : n);
  return 1700000000;
}

/** Format a deterministic epoch as an ISO 8601 UTC timestamp. */
export function isoTime(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}
