import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import path from 'node:path';
import { Building, type FloorDef } from '../src/server/building.js';
import { parseProgress, whyCloneFailed } from '../src/server/clone.js';

// A stand-in for gh: `repo view` and `repo clone` from bare repositories in $FAKE_GH_REPOS. It says
// how far along it is the way git does, can wait first ($FAKE_GH_DELAY), hang ($FAKE_GH_HANG) or
// fail the way ssh does ($FAKE_GH_FAIL).
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "repo view")
    [ -d "$FAKE_GH_REPOS/$3.git" ] || { echo "GraphQL: Could not resolve to a Repository with the name '$3'." >&2; exit 1; }
    echo "{\\"nameWithOwner\\":\\"$3\\",\\"isEmpty\\":false}"
    ;;
  "repo clone")
    name="$3"; dest="$4"
    printf "Cloning into '%s'...\\n" "$dest" >&2
    [ -n "$FAKE_GH_FAIL" ] && { echo "$FAKE_GH_FAIL" >&2; echo "fatal: Could not read from remote repository." >&2; exit 128; }
    [ -n "$FAKE_GH_HANG" ] && exec sleep 600
    printf "Receiving objects:  42%% (42/100), 1.00 MiB | 512.00 KiB/s\\r" >&2
    [ -n "$FAKE_GH_DELAY" ] && sleep "$FAKE_GH_DELAY"
    git clone -q "$FAKE_GH_REPOS/$name.git" "$dest" || exit 1
    git -C "$dest" remote set-url origin "https://github.com/$name.git"
    ;;
esac
`;

// Windows can't exec the sh shim: execFile('gh') searches only .com/.exe/.bat/.cmd (and skips
// .bat/.cmd candidates unless spawned through a shell, CVE-2024-27980). There `gh` is a copy of
// node, so `gh repo view|clone …` runs the `repo` script node finds in its cwd, with the same
// arguments the sh shim reads ($2/$3/$4 become argv[2]/[3]/[4]).
const FAKE_REPO = `const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const [sub, name, dest] = process.argv.slice(2);
const repos = process.env.FAKE_GH_REPOS;
if (sub === 'view') {
  if (!existsSync(repos + '/' + name + '.git')) {
    console.error("GraphQL: Could not resolve to a Repository with the name '" + name + "'.");
    process.exit(1);
  }
  console.log(JSON.stringify({ nameWithOwner: name, isEmpty: false }));
} else if (sub === 'clone') {
  process.stderr.write("Cloning into '" + dest + "'...\\n");
  if (process.env.FAKE_GH_FAIL) {
    process.stderr.write(process.env.FAKE_GH_FAIL + '\\nfatal: Could not read from remote repository.\\n');
    process.exit(128);
  } else if (process.env.FAKE_GH_HANG) {
    setInterval(() => {}, 600000);
  } else {
    process.stderr.write('Receiving objects:  42% (42/100), 1.00 MiB | 512.00 KiB/s\\r');
    if (process.env.FAKE_GH_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_GH_DELAY) * 1000);
    const git = spawnSync('git', ['clone', '-q', repos + '/' + name + '.git', dest], { stdio: 'ignore' });
    if (git.error || git.status !== 0) process.exit(1);
    spawnSync('git', ['-C', dest, 'remote', 'set-url', 'origin', 'https://github.com/' + name + '.git'], { stdio: 'ignore' });
  }
}
`;

const fast = { clone: { tickMs: 50, stallMs: 1500 } };


function office(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-clone-'));
  const pids: number[] = [];
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, '.agent-office');
  mkdirSync(dataDir);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), FAKE_GH);
  chmodSync(path.join(bin, 'gh'), 0o755);
  const repos = path.join(root, 'github');
  // acme/game on "GitHub", with a commit.
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', work]);
  writeFileSync(path.join(work, 'index.html'), '<h1>game</h1>');
  execFileSync('git', ['-C', work, 'add', '.']);
  execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'first']);
  execFileSync('git', ['clone', '-q', '--bare', work, path.join(repos, 'acme', 'game.git')]);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_GH_REPOS = repos;
  for (const k of ['FAKE_GH_DELAY', 'FAKE_GH_HANG', 'FAKE_GH_FAIL']) delete process.env[k];
  const projects = path.join(root, 'projects');
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, path.join(bin, 'gh.exe'));
    mkdirSync(path.join(projects, 'acme'), { recursive: true });
    // The clone's and the view's cwd differ; node resolves `repo` against whichever it's handed.
    for (const dir of [root, dataDir, projects, path.join(projects, 'acme')]) writeFileSync(path.join(dir, 'repo'), FAKE_REPO);
  }
  /** The clones under way, as the office keeps them for the next one. */
  const saved = () => (existsSync(path.join(dataDir, 'cloning.json')) ? (JSON.parse(readFileSync(path.join(dataDir, 'cloning.json'), 'utf8')) as (FloorDef & { pid: number })[]) : []);
  const running = async () => {
    for (let i = 0; i < 200 && !saved().length; i++) await new Promise((r) => setTimeout(r, 25));
    const pid = saved()[0]?.pid;
    assert.ok(pid, 'the clone is in cloning.json');
    pids.push(pid);
    return pid;
  };
  return { root, dataDir, projects, saved, running };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Picking a running clone back up goes through POSIX process groups and ps (CloneRun.adopt refuses
// both on Windows, where the office instead reports the clone stopped) — same gate as production.
const groups = process.platform !== 'win32';
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 25));
};

test('an explicit GitLab URL never clones the same path from GitHub', async (t) => {
  const { root, dataDir, projects } = office(t);
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, path.join(root, 'bin', 'glab.exe'));
    writeFileSync(path.join(dataDir, 'api'), 'process.exit(1)');
  } else {
    writeFileSync(path.join(root, 'bin', 'glab'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  const building = new Building(dataDir, projects, fast);
  const result = await building.add('https://gitlab.com/acme/game', 'Sam', () => {});
  assert.equal(typeof result, 'string');
  assert.deepEqual(building.list(), []);
  assert.equal(existsSync(path.join(projects, 'acme', 'game', 'index.html')), false);
});

test('a GitHub checkout cannot be reused for a GitLab project with the same path', async (t) => {
  const { root, dataDir, projects } = office(t);
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, path.join(root, 'bin', 'glab.exe'));
    writeFileSync(path.join(dataDir, 'api'), 'console.log(JSON.stringify({path_with_namespace: "acme/game"}))');
  } else {
    writeFileSync(path.join(root, 'bin', 'glab'), '#!/bin/sh\necho \'{"path_with_namespace":"acme/game"}\'\n', { mode: 0o755 });
  }
  const building = new Building(dataDir, projects, fast);
  const first = await building.add('acme/game', 'Sam', () => {});
  assert.equal(typeof first, 'object');
  building.remove((first as FloorDef).id);
  const result = await building.add('https://gitlab.com/acme/game', 'Sam', () => {});
  assert.match(String(result), /isn't a checkout of gitlab\/acme\/game/);
  assert.deepEqual(building.list(), []);
});

test("git's progress reads as a step, how far and how fast", () => {
  const out = "Cloning into '/x/acme/game'...\nremote: Enumerating objects: 2742, done.\nremote: Counting objects: 100% (5/5), done.\nReceiving objects:  12% (330/2742), 40.12 MiB | 1.52 MiB/s\rReceiving objects:  64% (1755/2742), 231.40 MiB | 1.50 MiB/s\r";
  assert.deepEqual(parseProgress(out), { step: 'Downloading', percent: 64, detail: '231.40 MiB · 1.50 MiB/s' });
  assert.deepEqual(parseProgress(`${out}Receiving objects: 100% (2742/2742), 362.00 MiB | 1.50 MiB/s, done.\nResolving deltas:  30% (3/10)\r`), { step: 'Unpacking', percent: 30 });
  assert.deepEqual(parseProgress('remote: Compressing objects:  50% (1/2)\r'), { step: 'GitHub is packing it up', percent: 50 });
  assert.deepEqual(parseProgress('Updating files:  99% (990/1000)\r'), { step: 'Checking out files', percent: 99 });
  assert.deepEqual(parseProgress("Cloning into '/x'...\n"), { step: 'Connecting to GitHub' });
  assert.equal(parseProgress(''), undefined);
});

test('a failed clone says what to do about it', () => {
  assert.match(whyCloneFailed("Cloning into 'x'...\nHost key verification failed.\nfatal: Could not read from remote repository.\n"), /ssh -T git@github\.com/);
  assert.match(whyCloneFailed('git@github.com: Permission denied (publickey).\n'), /gh ssh-key add/);
  assert.match(whyCloneFailed("fatal: could not read Username for 'https://github.com': terminal prompts disabled\n"), /gh auth setup-git/);
  assert.equal(whyCloneFailed('Receiving objects:  1% (1/100)\rerror: RPC failed\nfatal: early EOF\n'), 'error: RPC failed fatal: early EOF');
});

test('a clone shows how far along it is, then becomes a floor', async (t) => {
  const { dataDir, projects, saved } = office(t);
  process.env.FAKE_GH_DELAY = '0.6';
  const building = new Building(dataDir, projects, fast);
  const seen: unknown[] = [];
  let id = '';
  building.watchClones(() => seen.push(building.cloneProgress(id)));
  const r = await building.add('acme/game', 'Sam', (def) => (id = def.id));
  assert.equal(typeof r, 'object', String(r));
  assert.deepEqual(seen.at(-1), { step: 'Downloading', percent: 42, detail: '1.00 MiB · 512.00 KiB/s' });
  assert.ok(existsSync(path.join(projects, 'acme', 'game', 'index.html')));
  assert.deepEqual(building.list().map((d) => d.repo), ['acme/game']);
  assert.deepEqual(building.pending(), []);
  assert.deepEqual(saved(), [], "cloning.json is gone once it's done");
  assert.deepEqual(readdirSync(path.join(dataDir, 'clones')), [], 'and so is its log');
});

test("a clone that goes quiet is stopped as stalled, and one that can't sign in says why", async (t) => {
  const { dataDir, projects, running } = office(t);
  process.env.FAKE_GH_HANG = '1';
  const building = new Building(dataDir, projects, fast);
  const r = building.add('acme/game', 'Sam', () => {});
  const pid = await running();
  assert.match(String(await r), /stalled/);
  await until(() => !alive(pid));
  assert.ok(!alive(pid), 'the clone was stopped');
  assert.deepEqual(building.pending(), []);

  delete process.env.FAKE_GH_HANG;
  process.env.FAKE_GH_FAIL = 'Host key verification failed.';
  assert.match(String(await building.add('acme/game', 'Sam', () => {})), /^Couldn't clone acme\/game: ssh .*host key/);
  assert.deepEqual(building.list(), []);
});

test('a clone can be stopped by an admin or whoever added it', async (t) => {
  const { dataDir, projects, running } = office(t);
  process.env.FAKE_GH_HANG = '1';
  const building = new Building(dataDir, projects, { clone: { tickMs: 50 } });
  let id = '';
  const r = building.add('acme/game', 'Sam', (def) => (id = def.id), 'sam-account');
  const pid = await running();
  assert.match(String(building.cancel(id, 'Ann stopped the clone', (owner) => owner === 'ann-account')), /Only admins/);
  assert.equal(building.cancel(id, 'Sam stopped the clone', (owner) => owner === 'sam-account'), undefined);
  assert.equal(await r, 'Sam stopped the clone');
  await until(() => !alive(pid));
  assert.ok(!alive(pid));
  assert.deepEqual(building.list(), []);
  assert.equal(building.cancel(id, 'again', () => true), 'No such floor');
});

test('a restart mid-clone picks the clone back up, and it becomes its floor', { skip: groups ? false : 'CloneRun.adopt needs POSIX process groups and ps, which Windows lacks' }, async (t) => {
  const { dataDir, projects, saved, running } = office(t);
  process.env.FAKE_GH_DELAY = '1';
  const first = new Building(dataDir, projects, fast);
  void first.add('acme/game', 'Sam', () => {});
  await running();
  // The office restarts (tsx watch, systemd): the clone carries on without it.
  first.shutdown(true);
  const second = new Building(dataDir, projects, fast);
  const done: (FloorDef | string)[] = [];
  second.resumeClones((r) => done.push(r));
  assert.deepEqual(second.pending().map((d) => d.repo), ['acme/game'], "it's on its way again");
  await until(() => done.length > 0);
  assert.equal(typeof done[0], 'object', String(done[0]));
  assert.deepEqual(second.list().map((d) => d.repo), ['acme/game']);
  assert.deepEqual(saved(), []);
  // Saved, so the next office has it too.
  assert.deepEqual(new Building(dataDir, projects).list().map((d) => d.repo), ['acme/game']);
});

test('a clone that finished while no office was watching becomes its floor at the next start', async (t) => {
  const { dataDir, projects, running } = office(t);
  process.env.FAKE_GH_DELAY = '0.3';
  const first = new Building(dataDir, projects, fast);
  void first.add('acme/game', 'Sam', () => {});
  const pid = await running();
  first.shutdown(true);
  await until(() => !alive(pid));
  const done: (FloorDef | string)[] = [];
  new Building(dataDir, projects, fast).resumeClones((r) => done.push(r));
  assert.equal(done.length, 1);
  assert.equal((done[0] as FloorDef).repo, 'acme/game');
});

test("a clone that was cut off isn't taken for a checkout", async (t) => {
  const { dataDir, projects } = office(t);
  const dest = path.join(projects, 'acme', 'game');
  execFileSync('git', ['init', '-q', dest]);
  execFileSync('git', ['-C', dest, 'remote', 'add', 'origin', 'https://github.com/acme/game.git']);
  const building = new Building(dataDir, projects, fast);
  assert.match(String(await building.add('acme/game', 'Sam', () => {})), /didn't finish/);
  assert.deepEqual(building.list(), []);
});
