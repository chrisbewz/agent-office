import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CODEX_HOOK_EVENTS,
  codexHookArgs,
  codexModelArgs,
  normalizeCodexHook,
  validateCodexHook,
  writeCodexHook,
} from '../src/server/codex.js';
import { codex } from '../src/server/providers/codex.js';
import { codexMcpArgs } from '../src/server/office-workers.js';
import { createRequire } from 'node:module';

test('Windows Codex hook and MCP arguments leave room for the batch launcher', () => {
  const base = `C:\\Users\\example\\source\\repos\\project${'x'.repeat(50)}`;
  const args = [
    ...codexHookArgs(`${base}\\.agent-office\\agent-office-codex-hook.cjs`, 'win32'),
    ...codexMcpArgs(`${base}\\bin\\office-workers.js`), '--no-alt-screen', '--',
    'Read and follow the complete initial task in .agent-office/initial-prompts/123456789abc.txt. Begin work now.',
  ];
  const length = args.reduce((n, arg) => n + arg.length + (arg.match(/["\\]/g)?.length ?? 0) + 3, 0);
  assert.ok(length < 7_000, `Windows arguments consume ${length} characters before the launcher`);
});

test('Windows batch launcher starts with meeting-sized Codex arguments', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-codex-launch-'));
  try {
    const batch = path.join(dir, 'codex.cmd');
    const program = path.join(dir, 'codex.cjs');
    writeFileSync(program, "process.stdout.write('LAUNCH_OK');\n");
    writeFileSync(batch, `@echo off\r\n"${process.execPath}" "${program}" %*\r\n`);
    const hook = path.join(dir, 'a'.repeat(70), 'agent-office-codex-hook.cjs');
    const args = [...codexHookArgs(hook, 'win32'), ...codexMcpArgs(path.join(dir, 'office-workers.js')),
      '--no-alt-screen', '--', 'Read the initial task in .agent-office/initial-prompts/123456789abc.txt.'];
    const argsFile = path.join(dir, 'args.json');
    const runner = path.join(dir, 'runner.cjs');
    writeFileSync(argsFile, JSON.stringify(args));
    const ptyPath = createRequire(import.meta.url).resolve('@lydell/node-pty');
    writeFileSync(runner, `const fs = require('node:fs'); const pty = require(${JSON.stringify(ptyPath)});\n`
      + `const terminal = pty.spawn(process.argv[2], JSON.parse(fs.readFileSync(process.argv[3])), { cwd: process.cwd(), env: process.env, cols: 120, rows: 20 });\n`
      + `terminal.onData(data => fs.writeSync(1, data)); terminal.onExit(e => process.exit(e.exitCode));\n`);
    const output = execFileSync(process.execPath, [runner, batch, argsFile], { cwd: dir, encoding: 'utf8', timeout: 15_000 });
    assert.match(output, /LAUNCH_OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes bounded root Codex hook payloads and passes only the metric reader path', () => {
  assert.deepEqual(normalizeCodexHook('SessionStart', {
    session_id: 'thread-1', source: 'startup', transcript_path: '/private/transcript.jsonl', turn_id: 'turn-1',
  }), { sessionId: 'thread-1', event: 'SessionStart', source: 'startup', turnId: 'turn-1', transcriptPath: '/private/transcript.jsonl' });
  assert.deepEqual(normalizeCodexHook('UserPromptSubmit', {
    session_id: 'thread-1', prompt: '  fix the login  ', turn_id: 'turn-2', model: 'secret-model',
  }), { sessionId: 'thread-1', event: 'UserPromptSubmit', prompt: 'fix the login', turnId: 'turn-2' });
  assert.deepEqual(normalizeCodexHook('PermissionRequest', {
    session_id: 'thread-1', tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'secret' },
  }), { sessionId: 'thread-1', event: 'PermissionRequest', tool: 'Bash', toolUseId: 'tool-1' });
});

test('rejects unknown, malformed, empty, oversized, and child-scoped events', () => {
  assert.equal(validateCodexHook('Unknown', { session_id: 'x' }), false);
  assert.equal(validateCodexHook('Stop', null), false);
  assert.equal(validateCodexHook('Stop', { session_id: '' }), false);
  assert.equal(validateCodexHook('Stop', { session_id: 'x'.repeat(161) }), false);
  assert.equal(validateCodexHook('Stop', { session_id: 'x', agent_id: 'child-1' }), false);
  assert.equal(validateCodexHook('Stop', { session_id: 'x', agent_type: 'explorer' }), false);
  assert.equal(validateCodexHook('Stop', { session_id: 'x', agent_id: 'c'.repeat(161) }), false);
});

test('generates one stable CLI hook override per supported event', () => {
  const args = codexHookArgs('/tmp/office data/agent-office-codex-hook.cjs', 'linux');
  assert.equal(args.length, CODEX_HOOK_EVENTS.length * 2);
  for (let i = 0; i < CODEX_HOOK_EVENTS.length; i++) {
    assert.equal(args[i * 2], '-c');
    assert.match(args[i * 2 + 1], new RegExp(`^hooks\\.${CODEX_HOOK_EVENTS[i]}=\\[\\{hooks=`));
    assert.match(args[i * 2 + 1], /type="command"/);
    assert.match(args[i * 2 + 1], /timeout=3/);
    assert.match(args[i * 2 + 1], /agent-office-codex-hook\.cjs/);
  }
});

test('a worker\'s own model and effort go on Codex\'s command line, in place of an office-wide model', () => {
  assert.deepEqual(codexModelArgs([]), []);
  assert.deepEqual(codexModelArgs(['--yolo'], 'gpt-5.5', 'high'), ['--yolo', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="high"']);
  // Codex refuses --model twice: the office's --agent-args one gives way, however it was written.
  assert.deepEqual(codexModelArgs(['-m', 'gpt-6-astra', '--yolo'], 'gpt-5.5'), ['--yolo', '--model', 'gpt-5.5']);
  assert.deepEqual(codexModelArgs(['--model', 'gpt-6-astra'], 'gpt-5.5'), ['--model', 'gpt-5.5']);
  assert.deepEqual(codexModelArgs(['--model=gpt-6-astra', '-mgpt-6-astra', '--yolo'], 'gpt-5.5'), ['--yolo', '--model', 'gpt-5.5']);
  // With only an effort picked, the office-wide model stays.
  assert.deepEqual(codexModelArgs(['-m', 'gpt-6-astra'], undefined, 'xhigh'), ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="xhigh"']);
});

test('a Codex worker starts and resumes with a short first prompt as the CLI prompt', () => {
  const launch = (info: { model?: string; effort?: string }, more: { prompt?: string; resumeSessionId?: string } = {}) => {
    const h = { info: { id: 'worker-short', ...info }, state: codex.createState!() } as never;
    const result = codex.launch({ h, args: ['--yolo'], cwd: process.cwd(), setup: { hook: '/data/hook.cjs' }, ...more });
    return result.args;
  };
  const fresh = launch({ model: 'gpt-5.5', effort: 'high' }, { prompt: 'fix the login' });
  assert.deepEqual(fresh.slice(0, 5), ['--yolo', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(fresh.slice(-2), ['--', 'fix the login']);
  // Its options come before the `resume` subcommand, which then takes the session.
  const resumed = launch({ model: 'gpt-5.5', effort: 'high' }, { resumeSessionId: 'thread-1', prompt: 'continue it' });
  assert.deepEqual(resumed.slice(0, 5), ['--yolo', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(resumed.slice(-4), ['resume', 'thread-1', '--', 'continue it']);
  // Left on its defaults, nothing is added.
  const plain = launch({});
  assert.equal(plain.includes('--model'), false);
  assert.equal(plain.some((a) => a.startsWith('model_reasoning_effort')), false);
});

test('a long Codex initial prompt is read from a file instead of exceeding the Windows command limit', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-office-codex-prompt-'));
  const workerId = 'worker-1';
  const prompt = 'meeting brief\n'.repeat(1_500);
  const promptFile = path.join(cwd, '.agent-office', 'initial-prompts', `${workerId}.txt`);
  const h = { info: { id: workerId }, state: codex.createState!() } as never;
  try {
    const result = codex.launch({ h, args: [], prompt, cwd, setup: { hook: '/data/hook.cjs' } });
    assert.deepEqual(result.args.slice(-2), [
      '--',
      'Read and follow the complete initial task in .agent-office/initial-prompts/worker-1.txt. Begin work now.',
    ]);
    result.finishEnv?.({});
    assert.equal(readFileSync(promptFile, 'utf8'), prompt);
    assert.ok(result.args.join(' ').length < 8_191, 'the Codex batch command stays within cmd.exe’s limit');
    codex.exited?.(h, cwd);
    assert.equal(existsSync(promptFile), false, 'the office removes the prompt file when the worker exits');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('long Codex prompt files are excluded from a project git repository', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-office-codex-git-'));
  const h = { info: { id: 'worker-1' }, state: codex.createState!() } as never;
  try {
    execFileSync('git', ['init', '-q', cwd]);
    const result = codex.launch({ h, args: [], prompt: 'sensitive task '.repeat(1000), cwd, setup: { hook: '/data/hook.cjs' } });
    result.finishEnv?.({});
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
    assert.equal(status, '');
    execFileSync('git', ['check-ignore', '-q', '.agent-office/initial-prompts/worker-1.txt'], { cwd });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writes a mode-restricted helper that forwards paths without reading transcripts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-codex-'));
  try {
    const file = writeCodexHook(dir);
    assert.equal(file, path.join(dir, 'agent-office-codex-hook.cjs'));
    const source = readFileSync(file, 'utf8');
    assert.match(source, /MAX = 64 \* 1024/);
    assert.match(source, /AGENT_OFFICE_HOOK_TOKEN/);
    assert.doesNotMatch(source, /readFile|readSync|createReadStream/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('helper forwards only the bounded root event fields to the authenticated bridge', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-codex-'));
  const received: { url?: string; authorization?: string; body?: unknown } = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.url = req.url;
      received.authorization = req.headers.authorization;
      received.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200).end();
    });
  });
  try {
    const file = writeCodexHook(dir);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const child = spawn(process.execPath, [file, 'UserPromptSubmit'], {
      env: {
        PATH: process.env.PATH,
        AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${address.port}`,
        AGENT_OFFICE_HOOK_TOKEN: 'hook-token',
        AGENT_OFFICE_WORKER_ID: 'worker-1',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const stdout = await new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(output));
      child.stdin.end(JSON.stringify({
        session_id: 'thread-1', prompt: 'fix it', turn_id: 'turn-1',
        transcript_path: '/private/transcript.jsonl', model: 'private-model',
        tool_input: { command: 'private' }, hook_event_name: 'forged',
      }));
    });
    assert.equal(stdout, '{}');
    assert.equal(received.authorization, 'Bearer hook-token');
    assert.equal(received.url, '/hooks/codex?worker=worker-1&event=UserPromptSubmit');
    assert.deepEqual(received.body, {
      session_id: 'thread-1', hook_event_name: 'UserPromptSubmit', prompt: 'fix it', turn_id: 'turn-1',
      transcript_path: '/private/transcript.jsonl',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

// Run the generated command, rather than spawning the helper directly: the shell
// launch is what failed on Windows even though the direct helper tests passed.
test('Windows hook command forwards UTF-8 stdin through the shell with literal paths', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "office ' & $ hooks-"));
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200).end();
    });
  });
  const received: unknown[] = [];
  try {
    const file = writeCodexHook(dir);
    const config = codexHookArgs(file)[3]; // UserPromptSubmit
    const match = config.match(/command=("(?:[^"\\]|\\.)*"),timeout/);
    assert.ok(match);
    const command = JSON.parse(match[1]) as string;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    for (const shell of ['cmd.exe', 'powershell.exe']) {
      const args = shell === 'cmd.exe' ? ['/d', '/s', '/c', command] : ['-NoProfile', '-NonInteractive', '-Command', command];
      const child = spawn(shell, args, {
        env: { ...process.env, AGENT_OFFICE_CODEX_NODE: process.execPath, AGENT_OFFICE_CODEX_HOOK: file, AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${address.port}`, AGENT_OFFICE_HOOK_TOKEN: 'test', AGENT_OFFICE_WORKER_ID: 'worker-1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const exited = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      child.stdin.end(JSON.stringify({ session_id: 'thread-1', prompt: 'Fix caf\u00e9 \u4fee\u590d \u2728' }));
      assert.equal(await exited, 0, stderr);
      assert.equal(stdout, '{}', stderr);
    }
    assert.deepEqual(received, Array(2).fill({ session_id: 'thread-1', hook_event_name: 'UserPromptSubmit', prompt: 'Fix caf\u00e9 \u4fee\u590d \u2728' }));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
