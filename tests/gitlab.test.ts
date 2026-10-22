import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GitLab, friendlyGlabError } from '../src/server/gitlab.js';
import { repoOn } from '../src/server/forge.js';
import { normalizeRepo } from '../src/shared/floors.js';
import type { GhIssue, GhPull } from '../src/shared/protocol.js';

const issue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iid: 7,
  title: 'The dog walks through the jukebox',
  state: 'opened',
  web_url: 'https://gitlab.com/acme/app/-/issues/7',
  author: { username: 'ada' },
  labels: ['bug'],
  assignees: [],
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-01-03T03:04:05Z',
  description: 'Every lap, clang',
  user_notes_count: 2,
  ...over,
});

const mr = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iid: 7,
  title: 'Fix the gong',
  state: 'opened',
  draft: false,
  merge_status: 'can_be_merged',
  web_url: 'https://gitlab.com/acme/app/-/merge_requests/7',
  author: { username: 'ada' },
  labels: ['bug'],
  source_branch: 'fix-gong',
  target_branch: 'main',
  sha: 'abc123',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-01-03T03:04:05Z',
  description: 'It rings twice',
  head_pipeline: { status: 'success', name: 'ci', web_url: 'https://gitlab.com/acme/app/-/pipelines/1' },
  ...over,
});

const gqlMr = {
  iid: '7',
  title: 'Fix the gong',
  state: 'opened',
  draft: false,
  webUrl: 'https://gitlab.com/acme/app/-/merge_requests/7',
  author: { username: 'ada' },
  labels: { nodes: [{ title: 'bug', color: null }] },
  sourceBranch: 'fix-gong',
  targetBranch: 'main',
  sha: 'abc123',
  createdAt: '2026-01-02T03:04:05Z',
  updatedAt: '2026-01-03T03:04:05Z',
  description: 'It rings twice',
  pipeline: { status: 'success' },
  approvedBy: { nodes: [{ username: 'grace' }] },
  diffStats: [
    { path: 'a.ts', additions: 10, deletions: 2 },
    { path: 'b.ts', additions: 5, deletions: 0 },
  ],
};

/** A runner that answers the first endpoint its needle matches, and remembers what it was asked. */
function fake(map: [string, unknown][], log: string[][] = []) {
  return (args: string[], _cwd: string): Promise<string> => {
    log.push(args);
    for (const [needle, value] of map) if (args.some((a) => a.includes(needle))) return Promise.resolve(JSON.stringify(value));
    return Promise.resolve('[]');
  };
}

/** A runner that refuses anything matching `on`. */
function refusing(on: string, why = 'error: 401 unauthorized') {
  return (args: string[]): Promise<string> => (args.some((a) => a.includes(on)) ? Promise.reject(new Error(why)) : Promise.resolve('[]'));
}

const call = (log: string[][], needle: string) => log.find((a) => a.some((x) => x.includes(needle)));

test('a GitLab issue and merge request land on the boards in the shared shape', async () => {
  let issuesOut: GhIssue[] = [];
  let pullsOut: GhPull[] = [];
  const g = new GitLab(
    '/repo',
    (s) => (issuesOut = s.items),
    (s) => (pullsOut = s.items),
    fake([
      ['issues?state=opened', [issue()]],
      ['issues?state=closed', []],
      ['merge_requests?state=opened', [mr()]],
      ['merge_requests?state=merged', [mr({ iid: 6, state: 'merged' })]],
      ['merge_requests?state=closed', []],
    ]),
    'acme/app',
  );
  await g.refresh();
  assert.equal(issuesOut.length, 1);
  assert.deepEqual(
    { number: issuesOut[0].number, state: issuesOut[0].state, author: issuesOut[0].author, labels: issuesOut[0].labels, comments: issuesOut[0].comments, url: issuesOut[0].url },
    { number: 7, state: 'OPEN', author: 'ada', labels: [{ name: 'bug', color: '#888888' }], comments: 2, url: 'https://gitlab.com/acme/app/-/issues/7' },
  );
  assert.equal(pullsOut.length, 2);
  const open = pullsOut.find((p) => p.number === 7)!;
  assert.equal(open.state, 'OPEN');
  assert.equal(open.isDraft, false);
  assert.equal(open.checks, 'pass');
  const merged = pullsOut.find((p) => p.number === 6)!;
  assert.equal(merged.state, 'MERGED');
  assert.equal(merged.headRefName, 'fix-gong');
  assert.equal(merged.headRefOid, 'abc123');
  assert.equal(merged.baseRefName, 'main');
  assert.equal(merged.reviewDecision, '');
  assert.deepEqual(merged.closes, []);
});

test('labels arrive as strings or objects', async () => {
  let issuesOut: GhIssue[] = [];
  const g = new GitLab(
    '/repo',
    (s) => (issuesOut = s.items),
    () => {},
    fake([
      ['issues?state=opened', [issue({ labels: [{ name: 'ux', color: 'aabbcc' }, 'bug'] })]],
      ['issues?state=closed', []],
    ]),
    'acme/app',
  );
  await g.refresh();
  assert.deepEqual(issuesOut[0].labels, [
    { name: 'ux', color: '#aabbcc' },
    { name: 'bug', color: '#888888' },
  ]);
});

test('a draft MR is recognized from its flag or its title', async () => {
  const boards = (m: Record<string, unknown>): Promise<GhPull[]> => {
    let pullsOut: GhPull[] = [];
    const g = new GitLab(
      '/repo',
      () => {},
      (s) => (pullsOut = s.items),
      fake([
        ['merge_requests?state=opened', [mr(m)]],
        ['merge_requests?state=merged', []],
        ['merge_requests?state=closed', []],
        ['issues?state=opened', []],
        ['issues?state=closed', []],
      ]),
      'acme/app',
    );
    return g.refresh().then(() => pullsOut);
  };
  assert.equal((await boards({ draft: true })).find((p) => p.number === 7)?.isDraft, true);
  assert.equal((await boards({ draft: false, title: '[Draft] Fix the gong' })).find((p) => p.number === 7)?.isDraft, true);
  assert.equal((await boards({})).find((p) => p.number === 7)?.isDraft, false);
});

test('merge sends squash and branch deletion as flags, and auto as pipeline-waiting', async () => {
  const log: string[][] = [];
  const g = new GitLab('/repo', () => {}, () => {}, fake([['/merge', {}]], log), 'acme/app');
  await g.merge(7, 'squash', true, false);
  const merged = call(log, 'merge_requests/7/merge')!;
  assert.equal(merged[1], '--method');
  assert.equal(merged[2], 'PUT');
  assert.ok(merged.some((a) => a === 'squash=true'));
  assert.ok(merged.some((a) => a === 'should_remove_source_branch=true'));
  assert.ok(!merged.some((a) => a === 'merge_when_pipeline_succeeds=true'));
  await g.merge(7, 'merge', false, true);
  const auto = log.filter((a) => a.some((x) => x.includes('merge_requests/7/merge'))).at(-1)!;
  assert.ok(auto.some((a) => a === 'squash=false'));
  assert.ok(auto.some((a) => a === 'merge_when_pipeline_succeeds=true'));
  assert.ok(!auto.some((a) => a === 'should_remove_source_branch=true'));
});

test('closing an issue says so with state_event, and comments first', async () => {
  const log: string[][] = [];
  const g = new GitLab('/repo', () => {}, () => {}, fake([['issues/7', {}]], log), 'acme/app');
  await g.close('issue', 7, { comment: 'done' });
  assert.ok(call(log, '/issues/7/notes')?.some((a) => a === 'body=done'));
  const closed = call(log, 'state_event=close')!;
  assert.ok(closed.some((a) => a.includes('/issues/7')));
});

test('closing an MR can take its branch with it', async () => {
  const log: string[][] = [];
  const g = new GitLab(
    '/repo',
    () => {},
    () => {},
    fake([
      ['merge_requests/7/approvals', {}],
      ['merge_requests/7/notes', []],
      ['merge_requests/7/discussions', []],
      ['merge_requests/7/commits', []],
      ['merge_requests/7', mr()],
    ], log),
    'acme/app',
  );
  await g.close('pull', 7, { deleteBranch: true });
  assert.ok(call(log, 'repository/branches/fix-gong'));
});

test('comments post as notes and come back in the shared shape', async () => {
  const log: string[][] = [];
  const g = new GitLab(
    '/repo',
    () => {},
    () => {},
    fake([['/issues/7/notes', { id: 55, body: 'hi', author: { username: 'office' }, created_at: '2026-01-04T00:00:00Z', web_url: 'https://gitlab.com/acme/app/-/issues/7#note_55' }]], log),
    'acme/app',
  );
  const r = await g.comment('issue', 7, 'hi');
  assert.equal(r.error, undefined);
  assert.deepEqual({ author: r.comment?.author, body: r.comment?.body, id: r.comment?.id }, { author: 'office', body: 'hi', id: '55' });
  assert.ok(call(log, '/issues/7/notes')?.some((a) => a === 'body=hi'));
});

test('labels go on and come off in one PUT, and the board hears it at once', async () => {
  let pullsOut: GhPull[] = [];
  const log: string[][] = [];
  const g = new GitLab(
    '/repo',
    () => {},
    (s) => (pullsOut = s.items),
    fake([
      ['merge_requests/7', mr({ labels: ['ux', 'wip'] })],
      ['merge_requests?state=opened', [mr({ labels: ['ux', 'wip'] })]],
      ['merge_requests?state=merged', []],
      ['merge_requests?state=closed', []],
      ['issues?state=opened', []],
      ['issues?state=closed', []],
    ], log),
    'acme/app',
  );
  // The board has to be holding the pull request before the relabel can be seen on it.
  await g.refresh();
  const r = await g.setLabels('pull', 7, ['ux'], ['bug']);
  assert.equal(r.error, undefined);
  assert.equal(r.labels?.[0].name, 'ux');
  const put = call(log, 'add_labels=ux')!;
  assert.ok(put.some((a) => a === 'remove_labels=bug'));
  assert.ok(put.some((a) => a.includes('/merge_requests/7')));
  assert.deepEqual(pullsOut.find((p) => p.number === 7)?.labels.map((l) => l.name), ['ux', 'wip']);
});

test('claiming assigns the office token user to the issue', async () => {
  const log: string[][] = [];
  const g = new GitLab(
    '/repo',
    () => {},
    () => {},
    fake([
      ['user', { id: 42, username: 'office' }],
      ['issues?state=opened', []],
      ['issues?state=closed', []],
    ], log),
    'acme/app',
  );
  assert.equal(await g.claim(7), undefined);
  assert.ok(call(log, 'assignee_ids=42')?.some((a) => a.includes('/issues/7')));
});

test('claim failure comes back as an error string', async () => {
  const g = new GitLab('/repo', () => {}, () => {}, refusing('assignee_ids'), 'acme/app');
  assert.ok(typeof (await g.claim(7)) === 'string');
});

test('the PR window reads the MR, its approvals, its notes and its commits', async () => {
  const log: string[][] = [];
  const g = new GitLab(
    '/repo',
    () => {},
    () => {},
    fake([
      ['merge_requests/7/approvals', { approved_by: [{ user: { username: 'grace' } }] }],
      ['merge_requests/7/notes', []],
      ['merge_requests/7/discussions', []],
      ['merge_requests/7/commits', [{ id: 1 }, { id: 2 }, { id: 3 }]],
      ['merge_requests/7', mr()],
      ['projects/', { id: 1, path_with_namespace: 'acme/app' }],
      ['user', { id: 9, username: 'office' }],
    ], log),
    'acme/app',
  );
  const d = await g.pullDetail(7);
  assert.equal(d.reviewDecision, 'APPROVED');
  assert.equal(d.reviews[0]?.author, 'grace');
  assert.equal(d.state, 'OPEN');
  assert.equal(d.commits, 3);
  assert.equal(d.mergeable, 'MERGEABLE');
  assert.equal(d.viewer, 'office');
  assert.equal(d.repo.nameWithOwner, 'acme/app');
  assert.ok(call(log, '/approvals'));
});

test('the diff comes from glab mr diff', async () => {
  const log: string[][] = [];
  // `glab mr diff` prints the diff itself, so this answer is not JSON like the rest.
  const raw = (args: string[]): Promise<string> => (log.push(args), Promise.resolve('diff text'));
  const g = new GitLab('/repo', () => {}, () => {}, raw, 'acme/app');
  assert.equal(await g.pullDiff(7), 'diff text');
  assert.deepEqual(call(log, 'diff'), ['mr', 'diff', '7']);
});

test('the viewer is asked once and remembered', async () => {
  const log: string[][] = [];
  const g = new GitLab('/repo', () => {}, () => {}, fake([['user', { id: 9, username: 'office' }]], log), 'acme/app');
  await g.viewer();
  await g.viewer();
  assert.equal(log.filter((a) => a[0] === 'api' && a[1] === 'user').length, 1);
});

test('friendlyGlabError speaks for the board', () => {
  assert.match(friendlyGlabError('error: authentication required'), /glab isn't signed in/);
  assert.match(friendlyGlabError('error: 404 project not found'), /can't find this repository/);
  assert.equal(friendlyGlabError('fatal: not a git repository'), "This folder isn't a git repository");
});

test('repoOn reads the forges off remote URLs', () => {
  assert.deepEqual(repoOn('https://github.com/acme/app.git'), { host: 'github', repo: 'acme/app' });
  assert.deepEqual(repoOn('git@github.com:acme/app.git'), { host: 'github', repo: 'acme/app' });
  assert.deepEqual(repoOn('https://gitlab.com/group/app'), { host: 'gitlab', repo: 'group/app' });
  assert.deepEqual(repoOn('ssh://git@gitlab.com/group/sub/app.git'), { host: 'gitlab', repo: 'group/sub/app' });
  assert.equal(repoOn('https://bitbucket.org/acme/app'), undefined);
  assert.equal(repoOn('not a url'), undefined);
  process.env.GITLAB_HOST = 'gitlab.example.com';
  try {
    assert.deepEqual(repoOn('https://gitlab.example.com/acme/app.git'), { host: 'gitlab', repo: 'acme/app' });
    assert.deepEqual(repoOn('ssh://git@gitlab.example.com/example-team/development/training/app.git'), {
      host: 'gitlab',
      repo: 'example-team/development/training/app',
    });
    assert.deepEqual(
      repoOn(
        'https://gitlab.example.com/example-department-with-long-group-name/digital-products/training/app.git',
      ),
      {
        host: 'gitlab',
        repo: 'example-department-with-long-group-name/digital-products/training/app',
      },
    );
    assert.equal(repoOn('https://gitlab.other.example/acme/app'), undefined);
  } finally {
    delete process.env.GITLAB_HOST;
  }
});

test('normalizeRepo takes GitLab project paths and URLs too', () => {
  assert.equal(normalizeRepo('https://gitlab.com/group/app'), 'group/app');
  assert.equal(normalizeRepo('gitlab.com/group/sub/app'), 'group/sub/app');
  assert.equal(normalizeRepo('gitlab.com/example-team/development/training/app'), 'example-team/development/training/app');
  assert.equal(normalizeRepo('https://github.com/acme/app.git'), 'acme/app');
  assert.equal(normalizeRepo('https://bitbucket.org/acme/app'), undefined);
  // A long top group and four path segments. The normalizer only guards the
  // shape — whether the project exists is the forge's word.
  assert.equal(
    normalizeRepo('example-department-with-a-long-group-name-for-testing/product-development/control-software/shared-configuration'),
    'example-department-with-a-long-group-name-for-testing/product-development/control-software/shared-configuration',
  );
  assert.equal(normalizeRepo('example-department-with-a-long-group-name-for-testing/product-development/example-app'), 'example-department-with-a-long-group-name-for-testing/product-development/example-app');
});

// The clone folder mirrors the project's path, and names the floor after the project — not after
// the first group of a nested GitLab path (projects/example-team/development/training/app).
test('a nested project clones into its whole path, named after the project', () => {
  const dest = (repo: string): string => path.join('/projects', ...repo.split('/'));
  assert.equal(dest(normalizeRepo('gitlab.com/example-team/development/training/app')!), path.join('/projects', 'example-team', 'development', 'training', 'app'));
  assert.equal(dest(normalizeRepo('https://github.com/acme/app.git')!), path.join('/projects', 'acme', 'app'));
  assert.equal(path.basename(dest(normalizeRepo('gitlab.com/example-team/development/training/app')!)), 'app');
});

test('the cards read approvals and diff sizes off the batched GraphQL look', async () => {
  let pullsOut: GhPull[] = [];
  const log: string[][] = [];
  const g = new GitLab(
    '/repo',
    () => {},
    (s) => (pullsOut = s.items),
    fake([
      ['graphql', { data: { project: { mergeRequests: { nodes: [gqlMr] } } } }],
      ['issues?state=opened', []],
      ['issues?state=closed', []],
    ], log),
    'acme/app',
  );
  await g.refresh();
  const card = pullsOut.find((p) => p.number === 7)!;
  assert.equal(card.state, 'OPEN');
  assert.equal(card.reviewDecision, 'APPROVED');
  assert.equal(card.additions, 15);
  assert.equal(card.deletions, 2);
  assert.equal(card.checks, 'pass');
  assert.deepEqual(card.labels, [{ name: 'bug', color: '#888888' }]);
  // One batched look per state, and the REST list never asked.
  assert.equal(log.filter((a) => a.some((x) => x === 'graphql')).length, 3);
  assert.ok(!log.some((a) => a.some((x) => x.includes('merge_requests?state='))));
  // The query went to the project by its full path, for this state.
  const q = log.find((a) => a.some((x) => x === 'graphql'))!.find((x) => x.startsWith('query='))!;
  assert.ok(q.includes('"acme/app"'));
  assert.ok(q.includes('state: opened'));
});

test('when GitLab will not answer GraphQL, the REST list answers and the cards lose only the extras', async () => {
  let pullsOut: GhPull[] = [];
  const g = new GitLab(
    '/repo',
    () => {},
    (s) => (pullsOut = s.items),
    (args: string[]): Promise<string> => (args.some((x) => x === 'graphql') ? Promise.reject(new Error('field not supported')) : Promise.resolve(JSON.stringify([mr()]))),
    'acme/app',
  );
  await g.refresh();
  const card = pullsOut.find((p) => p.number === 7)!;
  assert.equal(card.state, 'OPEN');
  assert.equal(card.reviewDecision, '');
  assert.equal(card.additions, 0);
  assert.equal(card.deletions, 0);
});
