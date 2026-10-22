// The floor's GitLab boards: the same boards GitHub serves (see github.ts), served from a GitLab
// repository. The office talks to GitLab through the `glab` CLI's `api` passthrough, so glab owns
// the how of signing in (GITLAB_TOKEN, GITLAB_HOST, `glab auth login`) and this file only turns
// GitLab's REST shapes into the boards' shared protocol types.

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { BoardBackend } from './board.js';
import { Claims } from './github.js';
import type { GhAs } from './signins.js';
import { normalizeRepo } from '../shared/floors.js';
import type { GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPull, GhPullDetail, GhRepoInfo, GhReviewComment, GhState, RepoChoice } from '../shared/protocol.js';

/** How long the repo's list of labels is kept before the label picker asks GitLab again. */
const LABELS_MS = 60_000;
/** Past this a review body can't ride the command line to glab. */
const REVIEW_MAX = 30_000;
type GlabRunner = (args: string[], cwd: string, timeout?: number, env?: Record<string, string>) => Promise<string>;

/** Turns glab's stderr into something a person standing at the board can act on. */
export function friendlyGlabError(raw: string): string {
  const lines = raw.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const text = lines.join(' ');
  const first = lines[0] ?? raw.trim();
  if (/^Unknown JSON field:/i.test(first)) return first;
  if (/no git remotes found|none of the git remotes/i.test(text)) return 'This project has no remote yet. Add one (git remote add origin <url>) to fill the boards.';
  if (/not a git repository/i.test(text)) return "This folder isn't a git repository";
  if (/auth|token|401|403/i.test(text)) return "glab isn't signed in to GitLab on the office's machine — run `glab auth login` there, or set GITLAB_TOKEN";
  if (/404|not found|cannot find/i.test(text)) return "glab can't find this repository on GitLab (check the remote and access)";
  return lines.slice(-2).join(' ') || raw;
}

/** Runs glab as the office. GitLab has no per-user sign-ins yet, so `as` stays unused (see gates.ts). */
export function glab(args: string[], cwd: string, timeout = 30_000, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('glab', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout, env }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim();
        reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'GitLab CLI (glab) is not installed on the server' : friendlyGlabError(msg)));
      } else resolve(stdout);
    });
  });
}

/** One GitLab API call as the office, for the pieces outside the boards (a worker opening an MR). */
export function glabApi(dir: string, endpoint: string, method: string | undefined, fields: string[], timeout = 60_000, env?: Record<string, string>): Promise<string> {
  return glab(['api', ...(method ? ['--method', method] : []), endpoint, ...fields], dir, timeout, env);
}

/** GitLab labels arrive as strings or as objects, depending on the endpoint. */
function labelsOf(raw: unknown): GhLabel[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((l: any) => (typeof l === 'string' ? { name: l, color: '#888888' } : { name: String(l?.name ?? ''), color: `#${String(l?.color ?? '888888').replace(/^#/, '')}` }))
    .filter((l) => l.name);
}

const when = (v: unknown) => (typeof v === 'string' ? v : '');

function commentOf(n: any): GhComment {
  return { id: String(n.id), author: n.author?.username ?? 'ghost', body: String(n.body ?? ''), createdAt: when(n.created_at), url: n.web_url ?? undefined };
}

/** The board's CI glance comes from the head pipeline, when the list carried one. */
function checksOf(p: any): GhPull['checks'] {
  const status = String(p?.status ?? '').toLowerCase();
  if (!status) return 'none';
  if (status === 'success') return 'pass';
  if (status === 'failed' || status === 'canceled') return 'fail';
  return 'pending';
}

function draftOf(p: any): boolean {
  return !!p.draft || /^\s*[[(]?draft\b/i.test(String(p.title ?? ''));
}

/** The board cards' look at one state of merge requests, in one batched query: the REST list lacks
 * the approvals (the review state) and the diff sizes the cards show. */
const GQL_PULLS = (full: string, state: string, perPage: number) =>
  `{ project(fullPath: ${JSON.stringify(full)}) { mergeRequests(state: ${state}, first: ${perPage}) { nodes { iid title state draft webUrl createdAt updatedAt description author { username } labels { nodes { title color } } sourceBranch targetBranch sha pipeline { status } approvedBy { nodes { username } } diffStats { path additions deletions } } } } }`;

export class GitLab implements BoardBackend {
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: false };
  private timer?: NodeJS.Timeout;
  private projectInfo?: Promise<{ id: number; nameWithOwner: string }>;
  private who?: Promise<{ id: number; username: string }>;
  private labelList?: { at: number; list: Promise<GhLabel[]> };
  /** Labels just changed from the office, by "issue:N" or "pull:N", and when. */
  private relabeled = new Map<string, { labels: GhLabel[]; at: number }>();
  private claims = new Claims();
  /** The look at the issues that's under way, if one is. */
  private listing?: Promise<void>;

  constructor(
    private dir: string,
    private onIssues: (s: GhState<GhIssue>) => void,
    private onPulls: (s: GhState<GhPull>) => void,
    private run: GlabRunner = glab,
    /** The project path as the floor's def knows it (a GitLab group may nest: group/subgroup/project). */
    private repo?: string,
  ) {}

  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 90_000);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh() {
    await Promise.all([this.refreshIssues(), this.refreshPulls()]);
  }

  /** The project path as the API takes it: each segment URL-encoded, the slashes kept as %2F. */
  private path(): string {
    if (this.repo) return this.repo.split('/').map(encodeURIComponent).join('%2F');
    // Without the def, ask git for the origin, as gh fills {owner}/{repo} from it for GitHub.
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: this.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    const m = /^(?:https?:\/\/|ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+(?::\d+)?)[:/](.+?)(?:\.git)?(?:[/?#].*)?$/i.exec(url);
    return (m?.[2] ?? '').split('/').map(encodeURIComponent).join('%2F');
  }

  /** The repository's full name and how it lets merge requests merge. Asked once (again after a failure). */
  repoInfo(): Promise<GhRepoInfo> {
    // GitLab takes squash as a flag on the merge call itself, so all three methods are offered;
    // on GitLab a rebase merge is a plain merge like any other.
    return this.project().then((p) => ({ nameWithOwner: p.nameWithOwner, methods: ['squash', 'merge', 'rebase'] }));
  }

  private project(): Promise<{ id: number; nameWithOwner: string }> {
    this.projectInfo ??= this.run(['api', `projects/${this.path()}`], this.dir).then((out) => {
      const p = JSON.parse(out);
      return { id: Number(p.id), nameWithOwner: String(p.path_with_namespace ?? this.repo ?? '') };
    });
    this.projectInfo.catch(() => (this.projectInfo = undefined));
    return this.projectInfo;
  }

  /** The office's own token's user, which is who it acts as on GitLab. Asked once; '' when glab can't say. */
  viewer(): Promise<string> {
    return this.user().then((u) => u.username).catch(() => '');
  }

  private user(): Promise<{ id: number; username: string }> {
    this.who ??= this.run(['api', 'user'], this.dir).then((out) => {
      const u = JSON.parse(out);
      return { id: Number(u.id), username: String(u.username ?? '') };
    });
    this.who.catch(() => (this.who = undefined));
    return this.who;
  }

  /** A PR's description, conversation, line comments, its approvals and whether it can merge. */
  async pullDetail(n: number, me?: string): Promise<GhPullDetail> {
    const path = this.path();
    const [detail, approvals, notes, discussions, commits, repo, viewer] = await Promise.all([
      this.run(['api', `projects/${path}/merge_requests/${n}`], this.dir).then(JSON.parse),
      this.run(['api', `projects/${path}/merge_requests/${n}/approvals`], this.dir).then(JSON.parse).catch(() => undefined),
      this.run(['api', `projects/${path}/merge_requests/${n}/notes?per_page=100&sort=asc`], this.dir).then(JSON.parse),
      this.run(['api', `projects/${path}/merge_requests/${n}/discussions?per_page=100`], this.dir).then(JSON.parse).catch(() => []),
      this.run(['api', `projects/${path}/merge_requests/${n}/commits?per_page=100`], this.dir).then(JSON.parse).catch(() => []),
      this.repoInfo(),
      me ? Promise.resolve(me) : this.viewer(),
    ]);
    // Approvals stand in for GitHub's reviews: GitLab has no approve/request-changes review states.
    const reviews: GhComment[] = ((approvals?.approved_by ?? []) as any[]).map((a) => ({
      id: `approve-${a.user?.username ?? ''}`,
      author: a.user?.username ?? 'ghost',
      body: '',
      createdAt: '',
      state: 'APPROVED',
    }));
    const reviewComments: GhReviewComment[] = [];
    for (const d of Array.isArray(discussions) ? discussions : []) {
      const notesIn = (d.notes ?? []).filter((x: any) => x.position?.new_path);
      notesIn.forEach((x: any, i: number) => {
        reviewComments.push({
          id: Number(x.id) || i + 1,
          replyTo: i > 0 ? Number(notesIn[0].id) || undefined : undefined,
          author: x.author?.username ?? 'ghost',
          body: String(x.body ?? ''),
          createdAt: when(x.created_at),
          url: '',
          path: String(x.position.new_path ?? ''),
          line: x.position.new_line ?? null,
          side: x.position.new_line == null ? 'LEFT' : 'RIGHT',
        });
      });
    }
    return {
      number: detail.iid,
      body: String(detail.description ?? ''),
      state: String(detail.state).toLowerCase() === 'opened' ? 'OPEN' : String(detail.state).toUpperCase(),
      isDraft: draftOf(detail),
      reviewDecision: reviews.length ? 'APPROVED' : '',
      headRefName: String(detail.source_branch ?? ''),
      baseRefName: String(detail.target_branch ?? ''),
      mergeable: detail.merge_status === 'can_be_merged' ? 'MERGEABLE' : detail.merge_status === 'cannot_be_merged' ? 'CONFLICTING' : 'UNKNOWN',
      mergeStateStatus: String(detail.detailed_merge_status?.name ?? detail.merge_status ?? 'UNKNOWN').toUpperCase(),
      commits: Array.isArray(commits) ? commits.length : 0,
      comments: (Array.isArray(notes) ? notes : []).filter((x: any) => !x.system).map(commentOf),
      reviews,
      reviewComments,
      // A pipeline answer always carries a status, so 'none' can't occur here; the cast only narrows the type.
      checks: detail.head_pipeline ? [{ name: String(detail.head_pipeline.name ?? 'pipeline'), state: checksOf(detail.head_pipeline) as 'pass' | 'fail' | 'pending', url: detail.head_pipeline.web_url ?? undefined }] : [],
      repo,
      viewer,
    };
  }

  /** The PR's unified diff. The REST API speaks JSON here, so glab's own `mr diff` prints it. */
  pullDiff(n: number): Promise<string> {
    return this.run(['mr', 'diff', String(n)], this.dir, 60_000);
  }

  async issueDetail(n: number, me?: string): Promise<GhIssueDetail> {
    const path = this.path();
    const [i, notes, viewer] = await Promise.all([
      this.run(['api', `projects/${path}/issues/${n}`], this.dir).then(JSON.parse),
      this.run(['api', `projects/${path}/issues/${n}/notes?per_page=100&sort=asc`], this.dir).then(JSON.parse),
      me ? Promise.resolve(me) : this.viewer(),
    ]);
    return {
      number: i.iid,
      state: String(i.state).toLowerCase() === 'opened' ? 'OPEN' : 'CLOSED',
      body: String(i.description ?? ''),
      comments: (Array.isArray(notes) ? notes : []).filter((x: any) => !x.system).map(commentOf),
      viewer,
    };
  }

  /** Comments on an issue or on an MR's conversation (to GitLab an MR is not an issue). */
  async comment(kind: 'issue' | 'pull', n: number, body: string): Promise<{ comment?: GhComment; error?: string }> {
    try {
      const path = this.path();
      const out = await this.run(['api', '--method', 'POST', `projects/${path}/${kind === 'pull' ? 'merge_requests' : 'issues'}/${n}/notes`, '-f', `body=${body}`], this.dir);
      const comment = commentOf(JSON.parse(out));
      void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
      return { comment };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** Posts a comment-only review (the meeting room's review panel) whose body is read from `file`. */
  async review(n: number, file: string): Promise<string> {
    const body = readFileSync(file, 'utf8');
    if (body.length > REVIEW_MAX) throw new Error(`The review is too long to post through glab (${REVIEW_MAX} characters at most)`);
    const path = this.path();
    const out = await this.run(['api', '--method', 'POST', `projects/${path}/merge_requests/${n}/notes`, '-f', `body=${body}`], this.dir, 60_000);
    void this.refreshPulls();
    return String(JSON.parse(out)?.web_url ?? '') || `note on !${n}`;
  }

  /** Merges an MR, or with `auto` has GitLab merge it once its pipeline passes. */
  async merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean): Promise<string | undefined> {
    try {
      const path = this.path();
      const args = ['api', '--method', 'PUT', `projects/${path}/merge_requests/${n}/merge`, '-f', `squash=${method === 'squash'}`, '-f', `should_remove_source_branch=${deleteBranch}`];
      if (auto) args.push('-f', 'merge_when_pipeline_succeeds=true');
      await this.run(args, this.dir, 90_000);
    } catch (err) {
      return (err as Error).message;
    }
    void this.refreshPulls();
    return undefined;
  }

  /** Closes an issue, or an MR without merging it. GitLab has no close reason; a comment first, if any. */
  async close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }): Promise<string | undefined> {
    try {
      const path = this.path();
      const what = kind === 'pull' ? 'merge_requests' : 'issues';
      if (opts.comment) await this.run(['api', '--method', 'POST', `projects/${path}/${what}/${n}/notes`, '-f', `body=${opts.comment}`], this.dir);
      await this.run(['api', '--method', 'PUT', `projects/${path}/${what}/${n}`, '-f', 'state_event=close'], this.dir);
      if (kind === 'pull' && opts.deleteBranch) {
        const mr = JSON.parse(await this.run(['api', `projects/${path}/merge_requests/${n}`], this.dir));
        await this.run(['api', '--method', 'DELETE', `projects/${path}/repository/branches/${encodeURIComponent(String(mr.source_branch ?? ''))}`], this.dir).catch(() => undefined);
      }
    } catch (err) {
      return (err as Error).message;
    }
    // A refresh already in flight was asked before it closed and can still list it as open, so look again shortly after.
    const refresh = () => (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
    void refresh().then(() => {
      if ((kind === 'issue' ? this.issues : this.pulls).items.some((i) => i.number === n && i.state === 'OPEN')) setTimeout(() => void refresh(), 3000);
    });
    return undefined;
  }

  /** Every label the repository has, for the label picker. Asked again after a minute (or a failure). */
  repoLabels(): Promise<GhLabel[]> {
    if (!this.labelList || Date.now() - this.labelList.at > LABELS_MS) {
      const list = this.run(['api', `projects/${this.path()}/labels?per_page=100`], this.dir).then((out) =>
        (JSON.parse(out) as any[]).map((l) => ({ name: String(l.name), color: `#${String(l.color ?? '888888').replace(/^#/, '')}`, description: l.description || undefined })),
      );
      this.labelList = { at: Date.now(), list };
      list.catch(() => this.labelList?.list === list && (this.labelList = undefined));
    }
    return this.labelList.list;
  }

  /** Puts labels on an issue or MR and takes others off. Returns the labels it has now, or why they didn't change. */
  async setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[]): Promise<{ labels?: GhLabel[]; error?: string }> {
    try {
      const path = this.path();
      const args = ['api', '--method', 'PUT', `projects/${path}/${kind === 'pull' ? 'merge_requests' : 'issues'}/${n}`];
      if (add.length) args.push('-f', `add_labels=${add.join(',')}`);
      if (remove.length) args.push('-f', `remove_labels=${remove.join(',')}`);
      const now = labelsOf(JSON.parse(await this.run(args, this.dir))?.labels);
      const at = Date.now();
      this.relabeled.set(`${kind}:${n}`, { labels: now, at });
      if (kind === 'issue') {
        this.issues = { ...this.issues, items: this.relabel('issue', this.issues.items, at) };
        this.onIssues(this.issues);
        void this.refreshIssues();
      } else {
        this.pulls = { ...this.pulls, items: this.relabel('pull', this.pulls.items, at) };
        this.onPulls(this.pulls);
        void this.refreshPulls();
      }
      return { labels: now };
    } catch (err) {
      void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
      return { error: (err as Error).message };
    }
  }

  /** A worker took the issue: it moves to In progress on the board at once, and is assigned to the office's own token. */
  async claim(issue: number): Promise<string | undefined> {
    const answered = this.claims.take(issue);
    this.showClaims();
    try {
      const me = await this.user();
      await this.run(['api', '--method', 'PUT', `projects/${this.path()}/issues/${issue}`, '-f', `assignee_ids=${me.id}`], this.dir);
    } catch (err) {
      answered(false);
      this.showClaims();
      return (err as Error).message;
    }
    answered(true);
    // For its assignee's name. A look already under way was asked before it was assigned, so look again after it.
    void this.refreshIssues().then(() => (this.claims.has(issue) ? this.refreshIssues() : undefined));
    return undefined;
  }

  /** Puts the issues workers have taken on the board, ahead of the next look at GitLab. */
  private showClaims() {
    this.issues = { ...this.issues, items: this.claims.mark(this.issues.items) };
    this.onIssues(this.issues);
  }

  /** Asks GitLab for the issues. With a look already under way it's that one, which may have been asked before whatever just changed. */
  private refreshIssues(): Promise<void> {
    this.listing ??= this.listIssues().finally(() => (this.listing = undefined));
    return this.listing;
  }

  private async listIssues() {
    this.issues = { ...this.issues, loading: true };
    this.onIssues(this.issues);
    const asked = Date.now();
    try {
      const path = this.path();
      // Open and closed separately, so old open issues are never crowded out by recent closed ones.
      const [open, closed] = await Promise.all([
        this.run(['api', `projects/${path}/issues?state=opened&per_page=100&order_by=updated_at`], this.dir),
        this.run(['api', `projects/${path}/issues?state=closed&per_page=40&order_by=updated_at`], this.dir),
      ]);
      const fetched: GhIssue[] = [...(JSON.parse(open) as any[]), ...(JSON.parse(closed) as any[])].map((i) => ({
        number: i.iid,
        title: String(i.title ?? ''),
        state: String(i.state).toLowerCase() === 'opened' ? 'OPEN' : 'CLOSED',
        url: String(i.web_url ?? ''),
        author: i.author?.username ?? '',
        labels: labelsOf(i.labels),
        assignees: (i.assignees ?? []).map((a: any) => a.username),
        createdAt: when(i.created_at),
        updatedAt: when(i.updated_at),
        body: String(i.description ?? '').slice(0, 4000),
        comments: Number(i.user_notes_count ?? 0),
      }));
      const items = this.claims.mark(this.relabel('issue', fetched, asked), asked);
      this.issues = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.issues = { ...this.issues, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onIssues(this.issues);
  }

  private async refreshPulls() {
    if (this.pulls.loading) return;
    this.pulls = { ...this.pulls, loading: true };
    this.onPulls(this.pulls);
    const asked = Date.now();
    try {
      const path = this.path();
      const [open, merged, closed] = await Promise.all([
        this.listPulls(path, 'opened', 100),
        this.listPulls(path, 'merged', 30),
        this.listPulls(path, 'closed', 40),
      ]);
      const seen = new Set<number>();
      const all = [...open, ...merged, ...closed].filter((p: any) => !seen.has(p.iid) && seen.add(p.iid));
      const fetched: GhPull[] = all.map((p) => ({
        number: p.iid,
        title: String(p.title ?? ''),
        state: String(p.state).toLowerCase() === 'opened' ? 'OPEN' : String(p.state).toLowerCase() === 'merged' ? 'MERGED' : 'CLOSED',
        isDraft: draftOf(p),
        url: String(p.web_url ?? ''),
        author: p.author?.username ?? '',
        labels: labelsOf(p.labels),
        // The GraphQL list carries approvals; the REST fallback doesn't (the window asks the MR itself).
        reviewDecision: p.reviewDecision ?? '',
        headRefName: String(p.source_branch ?? ''),
        headRefOid: typeof p.sha === 'string' ? p.sha : undefined,
        baseRefName: String(p.target_branch ?? ''),
        createdAt: when(p.created_at),
        updatedAt: when(p.updated_at) || when(p.created_at),
        // The GraphQL list sums the diff stats; the REST fallback carries none.
        additions: p.additions ?? 0,
        deletions: p.deletions ?? 0,
        checks: checksOf(p.head_pipeline ?? p.pipeline),
        body: String(p.description ?? '').slice(0, 4000),
        closes: [],
      }));
      const items = this.relabel('pull', fetched, asked);
      this.pulls = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.pulls = { ...this.pulls, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onPulls(this.pulls);
  }

  private async listPulls(path: string, state: string, perPage: number): Promise<any[]> {
    // GraphQL first: it carries the approvals and diff sizes the REST list lacks. When GitLab
    // won't answer it, the REST list answers instead, and the cards show neither.
    try {
      const gql = await this.listPullsGql(path, state, perPage);
      if (gql) return gql;
    } catch {
      // fall through to REST
    }
    return JSON.parse(await this.run(['api', `projects/${path}/merge_requests?state=${state}&per_page=${perPage}&order_by=updated_at`], this.dir));
  }

  /** The GraphQL look, reshaped into the REST list's shapes so the board mapping runs unchanged.
   * Undefined when GitLab answers without the expected shape. `path` is the encoded project path. */
  private async listPullsGql(path: string, state: string, perPage: number): Promise<any[] | undefined> {
    const full = this.repo ?? decodeURIComponent(path);
    const out = await this.run(['api', 'graphql', '-f', `query=${GQL_PULLS(full, state, perPage)}`], this.dir, 60_000);
    const nodes = JSON.parse(out)?.data?.project?.mergeRequests?.nodes;
    if (!Array.isArray(nodes)) return undefined;
    return nodes.map((p: any) => ({
      iid: Number(p.iid),
      title: String(p.title ?? ''),
      state: String(p.state ?? ''),
      draft: !!p.draft,
      web_url: String(p.webUrl ?? ''),
      author: { username: p.author?.username ?? '' },
      labels: (p.labels?.nodes ?? []).map((l: any) => l.title),
      source_branch: String(p.sourceBranch ?? ''),
      target_branch: String(p.targetBranch ?? ''),
      sha: typeof p.sha === 'string' ? p.sha : undefined,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      description: String(p.description ?? ''),
      head_pipeline: p.pipeline,
      // What the REST list lacks and the cards show. GitLab has no "changes requested": an
      // approval is the whole review state, as the API knows it.
      reviewDecision: (p.approvedBy?.nodes ?? []).length ? 'APPROVED' : '',
      additions: (p.diffStats ?? []).reduce((s: number, d: any) => s + Number(d.additions ?? 0), 0),
      deletions: (p.diffStats ?? []).reduce((s: number, d: any) => s + Number(d.deletions ?? 0), 0),
    }));
  }

  /** A list asked for before a label change made here still has the old labels, so the new ones are kept over it. */
  private relabel<T extends GhIssue | GhPull>(kind: 'issue' | 'pull', items: T[], asked: number): T[] {
    return items.map((it) => {
      const key = `${kind}:${it.number}`;
      const r = this.relabeled.get(key);
      if (!r) return it;
      if (r.at < asked) {
        this.relabeled.delete(key);
        return it;
      }
      return { ...it, labels: r.labels };
    });
  }
}

/**
 * The GitLab project at `wanted`, if glab can see it: its real path and whether it's still empty.
 * Undefined when glab isn't installed, isn't signed in, or the project isn't there — all of which
 * just mean "not a GitLab project", so the caller reports GitHub's error.
 */
export async function onGitLab(wanted: string, cwd: string): Promise<{ repo: string; empty: boolean } | undefined> {
 const path = wanted.split('/').map(encodeURIComponent).join('%2F');
 try {
 const project = JSON.parse(await glab(['api', `projects/${path}`], cwd, 30_000)) as { path_with_namespace?: unknown; empty_repo?: unknown };
 const repo = normalizeRepo(project.path_with_namespace) ?? wanted;
 return { repo, empty: project.empty_repo === true };
 } catch {
 return undefined;
 }
}

/** The GitLab projects this machine's glab login belongs to, most recently active first. Empty if
 * it can't say. Page by page: glab's api has no --jq, and its --paginate concatenates the pages'
 * arrays, so one JSON.parse of the lot dies on the second page — while a bare `page=` query
 * answers one clean array, and a short page is the end of the list. */
export async function gitlabRepos(cwd: string): Promise<RepoChoice[]> {
  const repos: RepoChoice[] = [];
  try {
    const perPage = 100;
    for (let page = 1; page <= 10; page++) {
      const out = await glab(['api', `projects?membership=true&per_page=${perPage}&order_by=last_activity_at&page=${page}`], cwd, 90_000);
      const list = JSON.parse(out) as { path_with_namespace?: unknown; description?: unknown; visibility?: unknown; last_activity_at?: unknown }[];
      if (!Array.isArray(list)) break;
      for (const p of list) {
        const name = normalizeRepo(p.path_with_namespace);
        if (!name) continue;
        repos.push({
          name,
          description: typeof p.description === 'string' && p.description ? p.description.slice(0, 200) : undefined,
          private: typeof p.visibility === 'string' && p.visibility !== 'public',
          pushedAt: typeof p.last_activity_at === 'string' ? p.last_activity_at : undefined,
        });
      }
      if (list.length < perPage) break;
    }
  } catch {
    return [];
  }
  return repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
}
