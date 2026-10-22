// The forges the office serves boards for: which remote URLs belong to which forge, and what a
// checkout's origin points at. GitHub and GitLab both speak the boards' shared shape (see board.ts).

import { execFileSync } from 'node:child_process';

/** The forges the office serves boards for. */
export type GitHost = 'github' | 'gitlab';

/** Where a checkout's origin points: the forge it lives on and its project path. */
export function originRemote(dir: string): { host: GitHost; repo: string } | undefined {
  let url: string;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    return undefined;
  }
  return repoOn(url);
}

/** The GitHub or GitLab repository a checkout's origin points at (either forge's project path). */
export function originRepo(dir: string): string | undefined {
  return originRemote(dir)?.repo;
}

/** The project path a checkout's origin points at, as GitLab's API takes it (each segment URL-encoded). */
export function originApiPath(dir: string): string | undefined {
  const remote = originRemote(dir);
  return remote ? remote.repo.split('/').map(encodeURIComponent).join('%2F') : undefined;
}

/** The forge a checkout's origin points at, or undefined when it's neither (asked of git: keep it out of loops). */
export function originHost(dir: string): GitHost | undefined {
  return originRemote(dir)?.host;
}

/** The project a remote URL points at, when it's a forge the office serves. */
export function repoOn(url: string): { host: GitHost; repo: string } | undefined {
  const m = /^(?:https?:\/\/|ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)(?::\d+)?[/:](.+)$/i.exec(url.trim());
  if (!m) return undefined;
  const host = hostOf(m[1]);
  if (!host) return undefined;
  // Everything after the host: the project path, maybe with .git or a path past the repository.
  const path = m[2].replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = path.split('/');
  // GitHub is always owner/name; GitLab nests groups arbitrarily deep.
  if (parts.length < 2 || parts.length > 8) return undefined;
  if (parts.some((p) => !/^[a-zA-Z0-9_.-]{1,100}$/.test(p) || p === '.' || p === '..')) return undefined;
  return { host, repo: parts.join('/') };
}

function hostOf(hostname: string): GitHost | undefined {
  const h = hostname.toLowerCase();
  if (h === 'github.com' || h.endsWith('.github.com')) return 'github';
  if (h === 'gitlab.com' || h.endsWith('.gitlab.com')) return 'gitlab';
  // A self-hosted GitLab, when the office says which one it serves (GITLAB_HOST=gitlab.corp.example).
  const self = (process.env.GITLAB_HOST ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (self && (h === self || h.endsWith(`.${self}`))) return 'gitlab';
  return undefined;
}
