import { normalizeRepo } from '../shared/floors.js';
import type { RepoChoice } from '../shared/protocol.js';
import { gh } from './github.js';
import { gitlabRepos } from './gitlab.js';

const MAX_REPOS = 1000;

export async function listRepos(cwd: string): Promise<RepoChoice[]> {
  let githubError: unknown;
  const out = await gh(
    [
      'api',
      '--paginate',
      'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
      '--jq',
      '.[] | {name: .full_name, description: (.description // ""), private: .private, pushedAt: .pushed_at}',
    ],
    cwd,
    90_000,
  ).catch((err: unknown) => { githubError = err; return ''; });
  const repos: RepoChoice[] = [];
  const seen = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { name?: unknown; description?: unknown; private?: unknown; pushedAt?: unknown };
      const name = normalizeRepo(r.name);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      repos.push({
        name,
        description: typeof r.description === 'string' && r.description ? r.description.slice(0, 200) : undefined,
        private: r.private === true,
        pushedAt: typeof r.pushedAt === 'string' ? r.pushedAt : undefined,
      });
    } catch {
      // not a line of ours
    }
    if (repos.length >= MAX_REPOS) break;
  }
  // The office's GitLab login may see more (or other) projects. Best effort: no glab, no GitLab repos, same picker.
  for (const r of await gitlabRepos(cwd)) {
    const key = `gitlab:${r.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push(r);
    if (repos.length >= MAX_REPOS) break;
  }
  if (githubError && !repos.length) throw githubError;
  return repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
}
