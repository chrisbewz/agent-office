import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROMPTS, PROMPT_IDS, PROMPT_MAX, fillPrompt, placeholders, promptText, stationDefault } from '../src/shared/prompts.js';
import { OfficePrompts, officePrompt, type PromptSource } from '../src/server/prompts.js';
import { stationBrief } from '../src/server/stations.js';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import type { AgentChoice, PromptsState, WorkerInfo } from '../src/shared/protocol.js';

function scratch(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-prompts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('placeholders are filled in once, unknown ones stay, and a line with nothing to say goes', () => {
  assert.equal(fillPrompt('Fix #{{number}}: {{ title }}', { number: 12, title: 'The dog' }), 'Fix #12: The dog');
  assert.equal(fillPrompt('Keep {{this}} as it is', { number: 1 }), 'Keep {{this}} as it is');
  // What goes in isn't looked at again.
  assert.equal(fillPrompt('"{{title}}" by {{who}}', { title: '{{who}}', who: 'Ada' }), '"{{who}}" by Ada');
  assert.equal(fillPrompt('About:\n{{about}}\n\n{{pr}}\n\n{{issue}}\n\nHow it runs.\n\n{{where}}', { about: 'X', pr: '', issue: 'Issue #3.', where: '' }), 'About:\nX\n\nIssue #3.\n\nHow it runs.');
  // Empty in the middle of a line is just empty.
  assert.equal(fillPrompt("Don't change it.{{before}} List them.", { before: '' }), "Don't change it. List them.");
  assert.deepEqual(placeholders('{{a}} {{ b }} {{a}} {{9x}}'), ['a', 'b']);
});

test('every default only uses placeholders it says it has, and names the ones the office counts on', () => {
  for (const id of PROMPT_IDS) {
    const def = PROMPTS[id];
    for (const name of placeholders(def.text)) assert.ok(name in def.vars, `${id} uses {{${name}}}`);
    for (const name of def.needs ?? []) assert.ok(placeholders(def.text).includes(name), `${id} needs {{${name}}}`);
    assert.ok(def.text.trim().length > 0, id);
  }
});

test('the boards send what they always did', () => {
  assert.equal(
    fillPrompt(PROMPTS['issue.work'].text, { number: 7, title: 'Dog barks', url: 'u' }),
    'Work on GitHub issue #7: "Dog barks".\n\nRead it first with `gh issue view 7 --comments`. Create a new branch, implement the change, verify it, then open a pull request that closes #7.',
  );
  const merge = fillPrompt(PROMPTS['pull.fixMerge'].text, { number: 5, title: 'T', url: 'https://github.com/o/r/pull/5', branch: 'feat', base: 'main', repo: 'o/r', merge: 'gh pr merge 5 --squash --repo o/r' });
  assert.match(merge, /^Get pull request #5 "T" \(https:\/\/github\.com\/o\/r\/pull\/5\) ready and merge it\.\n\n1\. Get onto its branch: `gh pr checkout 5`\. If git says `feat` is already checked out/);
  assert.match(merge, /git push origin HEAD:feat/);
  assert.match(merge, /gh api repos\/o\/r\/pulls\/5\/comments/);
  assert.match(merge, /6\. When the checks pass and no feedback is left, merge it: `gh pr merge 5 --squash --repo o\/r`\./);
  assert.doesNotMatch(merge, /\{\{/);
});

test('a rewritten prompt is kept, used, and put back to the default', (t) => {
  const dir = scratch(t);
  const told: PromptsState[] = [];
  const book = new OfficePrompts(dir, { list: ['claude', 'opencode', 'codex'], configured: 'claude' }, (s) => told.push(s));
  assert.equal(book.setPrompt('issue.work', 'Just do #{{number}}\r\n', 'Ada'), undefined);
  assert.equal(book.text('issue.work'), 'Just do #{{number}}');
  assert.equal(book.state().custom['issue.work']?.by, 'Ada');
  assert.equal(told.length, 1);

  // It's there after a restart.
  const again = new OfficePrompts(dir, { list: ['claude', 'opencode', 'codex'], configured: 'claude' }, () => {});
  assert.equal(officePrompt(again, 'issue.work', { number: 4 }), 'Just do #4');

  // The default's own text, or null, puts the default back.
  assert.equal(book.setPrompt('issue.work', PROMPTS['issue.work'].text, 'Ada'), undefined);
  assert.equal(book.state().custom['issue.work'], undefined);
  book.setPrompt('pull.review', 'Look at it', 'Ada');
  assert.equal(book.setPrompt('pull.review', null, 'Grace'), undefined);
  assert.equal(book.text('pull.review'), PROMPTS['pull.review'].text);

  // Empty only where empty means "send nothing"; never too long, never an unknown prompt.
  assert.match(book.setPrompt('issue.work', '  ', 'Ada') ?? '', /can’t be empty/);
  assert.equal(book.setPrompt('queue.worktree', '', 'Ada'), undefined);
  assert.equal(book.text('queue.worktree'), '');
  assert.match(book.setPrompt('issue.work', 'x'.repeat(PROMPT_MAX + 1), 'Ada') ?? '', /at most/);
  assert.match(book.setPrompt('nope', 'x', 'Ada') ?? '', /Unknown prompt/);
  assert.equal(promptText(book.state().custom, 'office.namer'), PROMPTS['office.namer'].text);
});

test('the default worker is checked before it is kept, and one the office can no longer start is forgotten', (t) => {
  const dir = scratch(t);
  const book = new OfficePrompts(dir, { list: ['claude', 'opencode', 'codex'], configured: 'claude' }, () => {});
  assert.equal(book.agent(), undefined);
  assert.match(book.setAgent({ provider: 'custom' }, 'Ada') ?? '', /Unknown agent provider/);
  assert.match(book.setAgent({ provider: 'claude', model: 'gpt-9' }, 'Ada') ?? '', /Invalid Claude model/);
  assert.match(book.setAgent({ provider: 'codex', model: 'gpt 5.5' }, 'Ada') ?? '', /Invalid Codex model/);
  assert.match(book.setAgent({ provider: 'codex', effort: 'enormous' as never }, 'Ada') ?? '', /Invalid effort/);
  assert.match(book.setAgent({ provider: 'opencode', model: 'no slash' }, 'Ada') ?? '', /Invalid OpenCode model/);
  assert.equal(book.setAgent({ provider: 'claude', model: 'opus', effort: 'high' }, 'Ada'), undefined);
  assert.deepEqual(book.agent(), { provider: 'claude', model: 'opus', effort: 'high' });
  assert.equal(book.state().agent?.by, 'Ada');
  assert.deepEqual(new OfficePrompts(dir, { list: ['claude', 'opencode', 'codex'], configured: 'claude' }, () => {}).agent(), { provider: 'claude', model: 'opus', effort: 'high' });
  assert.equal(book.setAgent(null, 'Ada'), undefined);
  assert.equal(book.agent(), undefined);

  // Custom, then the office comes back with another --agent: custom is gone.
  const file = path.join(dir, 'prompts.json');
  writeFileSync(file, JSON.stringify({ custom: {}, agent: { provider: 'custom', by: 'Ada', at: 1 } }));
  assert.deepEqual(new OfficePrompts(dir, { list: ['claude', 'opencode', 'codex', 'custom'], configured: 'custom' }, () => {}).agent(), { provider: 'custom' });
  assert.equal(new OfficePrompts(dir, { list: ['claude', 'opencode', 'codex'], configured: 'claude' }, () => {}).agent(), undefined);
  // A broken file is the defaults.
  writeFileSync(file, '{nope');
  assert.deepEqual(new OfficePrompts(dir, { list: ['claude'], configured: 'claude' }, () => {}).state(), { custom: {} });
  assert.ok(readFileSync(file, 'utf8'));
});

test('a board agent is told its rewritten brief', () => {
  const source: PromptSource = { text: (id) => (id === 'station.pulls' ? 'You review PRs. The request:' : PROMPTS[id].text), agent: () => undefined };
  assert.equal(stationBrief('pulls', source), 'You review PRs. The request:');
  assert.equal(stationBrief('issues', source), stationBrief('issues'));
});

function queueFixture(t: { after(fn: () => void): void }, officeDefault: AgentChoice | undefined, note?: string) {
  const dir = scratch(t);
  const workers: WorkerInfo[] = [];
  const manager: QueueWorkers = {
    defaultProvider: 'claude',
    officeDefault,
    list: () => workers,
    deskOccupied: (desk) => workers.some((w) => w.deskId === desk),
    spawn(deskId, by, prompt, _worktree, kind, provider, model, effort) {
      const w: WorkerInfo = { id: `w${workers.length}`, deskId, kind, provider, model, effort, prompt, name: 'T', color: '#fff', status: 'working', acked: false, createdBy: by, createdAt: Date.now(), cols: 80, rows: 24, viewers: [], viewerIds: [] };
      workers.push(w);
      return w;
    },
    kill: async () => ({}),
  };
  const queue = new TaskQueue(dir, manager, true, {
    update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {},
    ...(note !== undefined ? { worktreeNote: () => note } : {}),
  });
  t.after(() => queue.shutdown());
  return { queue, workers };
}

test('a task nobody picked a worker for runs on the office default; one that did keeps its own', (t) => {
  const { queue, workers } = queueFixture(t, { provider: 'claude', model: 'sonnet', effort: 'low' });
  assert.equal(queue.add('Fix the dog', 'Queue agent'), undefined);
  assert.deepEqual([workers[0].provider, workers[0].model, workers[0].effort], ['claude', 'sonnet', 'low']);
  assert.equal(queue.add('Fix the cat', 'Ada', undefined, undefined, 'claude', 'haiku'), undefined);
  assert.deepEqual([workers[1].provider, workers[1].model, workers[1].effort], ['claude', 'haiku', undefined]);
  // Without one set, it's the office's --agent on its own model.
  const plain = queueFixture(t, undefined);
  plain.queue.add('Fix it', 'Ada');
  assert.deepEqual([plain.workers[0].provider, plain.workers[0].model], ['claude', undefined]);
});

test('the worktree note the queue adds can be rewritten, or left off', (t) => {
  const standard = queueFixture(t, undefined);
  standard.queue.add('Fix it', 'Ada');
  assert.equal(standard.workers[0].prompt, `Fix it\n\n${PROMPTS['queue.worktree'].text}`);
  const rewritten = queueFixture(t, undefined, 'Push to your branch.');
  rewritten.queue.add('Fix it', 'Ada');
  assert.equal(rewritten.workers[0].prompt, 'Fix it\n\nPush to your branch.');
  const none = queueFixture(t, undefined, '');
  none.queue.add('Fix it', 'Ada');
  assert.equal(none.workers[0].prompt, 'Fix it');
});

test('a GitLab board brief names glab, and the GitHub one reads as it always did', () => {
  assert.equal(
    stationDefault('pulls'),
    `You're the PR agent in Agent Office, a shared 3D office where a team works alongside coding agents. You stand at a kiosk by the 🔀 Pull Requests board, and whoever walks up types you a request. The first one is at the end of this message.\n\nYou look after this repository's pull requests with the gh CLI: sum them up and review them (gh pr view, gh pr diff, gh pr checks), comment, approve or request changes, merge when you're asked to, and close stale ones. Read a PR's code with gh pr diff rather than checking its branch out here. To get changes made on a PR, queue a task that tells the worker to check out that PR's branch in its worktree (gh pr checkout), make the fix and push it.\n\nYou're in the project's main checkout, which other people and workers use too: don't switch branches, commit, or leave edits in it. Work that needs code changed goes on the task queue, unless the person asks you for something else.\n\nThe task queue gives each task a fresh worker in its own git worktree, a few at a time; a task usually ends with a pull request. Use it with the office-queue command, which is on your PATH (it knows who you are, so don't call the office's HTTP API yourself):\n- See it: office-queue list (each task's id, status, title, worker and pull request)\n- Add a task: office-queue add --title "Short title" [--issue <number>], with the task's prompt on stdin in a quoted heredoc so nothing in it gets expanded. It prints the new task's id. With --issue the task is linked to that GitHub issue, which is assigned when the task starts.\n  office-queue add --title "Fix the login redirect" <<'EOF'\n  …the full prompt…\n  EOF\n- Take a waiting task off: office-queue remove <id>\n\nWhen you've done what was asked, say in a few lines what you did, with links. Then wait: the next request may come from someone else.\n\nThe request:`,
  );
  const gitlab = stationDefault('pulls', 'gitlab');
  assert.match(gitlab, /merge requests with the glab CLI/);
  assert.match(gitlab, /\(glab mr view, glab mr diff, glab mr checks\)/);
  assert.match(gitlab, /\(glab mr checkout\)/);
  assert.match(gitlab, /a task usually ends with a merge request/);
  assert.match(gitlab, /linked to that GitLab issue/);
  assert.doesNotMatch(gitlab, /gh pr|gh issue|gh CLI|GitHub|pull request/);
  const issues = stationDefault('issues', 'gitlab');
  assert.match(issues, /GitLab issues with the glab CLI/);
  assert.doesNotMatch(issues, /GitHub|gh CLI/);
  const queue = stationDefault('queue', 'gitlab');
  assert.match(queue, /glab issue list only as far as it takes/);
  assert.match(queue, /Link a task to its GitLab issue/);
  assert.match(queue, /to open a merge request/);
  assert.doesNotMatch(queue, /gh issue|GitHub issue|pull request/);
});
