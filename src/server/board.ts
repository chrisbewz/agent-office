// The boards a floor's forge serves: GitHub (see github.ts) and GitLab (see gitlab.ts) both speak
// this, and the floor, its handlers and its routes can't tell the difference.

import type { GhAs } from './signins.js';
import type { GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPull, GhPullDetail, GhState } from '../shared/protocol.js';

/** A floor's issues and pull requests, wherever its repository lives. */
export interface BoardBackend {
  /** The issues board as last fetched. */
  issues: GhState<GhIssue>;
  /** The pull request board as last fetched. */
  pulls: GhState<GhPull>;
  /** Looks at both boards now. */
  refresh(): Promise<void>;
  /** Stops the backend's own timers. */
  stop(): void;
  /** Merges PR `n`, or has the forge merge it once its requirements pass (`auto`). Returns an error. */
  merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean, as?: GhAs): Promise<string | undefined>;
  /** Comments on an issue or a PR's conversation. Returns the comment as saved, or why it wasn't. */
  comment(kind: 'issue' | 'pull', n: number, body: string, as?: GhAs): Promise<{ comment?: GhComment; error?: string }>;
  /** Closes an issue, or a PR without merging it, optionally saying why. Returns an error. */
  close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }, as?: GhAs): Promise<string | undefined>;
  /** Puts labels on an issue or PR and takes others off. Returns the labels it has now, or why they didn't change. */
  setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[], as?: GhAs): Promise<{ labels?: GhLabel[]; error?: string }>;
  /** Assigns issue `n` to whoever acts (on GitLab, always the office's own token). Returns an error. */
  claim(issue: number, as?: GhAs): Promise<string | undefined>;
  /** Posts a comment-only review whose body is read from `file`. Resolves to its URL. */
  review(n: number, file: string, as?: GhAs): Promise<string>;
  /** What the PR window shows beyond the board card. `me` is the actor's own login, when they have one on this forge. */
  pullDetail(n: number, me?: string): Promise<GhPullDetail>;
  /** What the issue window shows beyond the board card. */
  issueDetail(n: number, me?: string): Promise<GhIssueDetail>;
  /** Every label the repository has, for the label picker. */
  repoLabels(): Promise<GhLabel[]>;
  /** The PR's unified diff, as `git diff` prints it. */
  pullDiff(n: number): Promise<string>;
}
