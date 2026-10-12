import { queryOne } from '../db/index.js';
import { GITHUB_TOKEN } from '../config.js';
import { getInstallationToken, getRepoInstallationToken } from './github-app.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

async function gh(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Morline-App',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000)
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new GitHubError(data?.message || `GitHub responded ${res.status}`, res.status);
  return data;
}

const refPath = (branch) => branch.split('/').map(encodeURIComponent).join('/');

export const getRepo = (token, repo) => gh(token, 'GET', `/repos/${repo}`);

export async function getBranchHead(token, repo, branch) {
  const ref = await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${refPath(branch)}`);
  return ref.object.sha;
}

/** Every file in the repo at `ref`, as `{ path, sha, size }`. */
export async function listFiles(token, repo, ref) {
  const tree = await gh(token, 'GET', `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  return (tree.tree || []).filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size || 0 }));
}

/** File content as UTF-8 text, or null when the blob is binary. */
export async function getBlobText(token, repo, sha) {
  const blob = await gh(token, 'GET', `/repos/${repo}/git/blobs/${sha}`);
  const buf = Buffer.from(blob.content || '', blob.encoding === 'base64' ? 'base64' : 'utf8');
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

export async function createBranch(token, repo, branch, sha) {
  await gh(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
}

export async function createPullRequest(token, repo, { title, head, base, body }) {
  return gh(token, 'POST', `/repos/${repo}/pulls`, { title, head, base, body });
}

/**
 * One atomic commit for many files. `changes` is `[{ path, action: 'create'|'update'|'delete', content }]`.
 * Fast-forwards `branch` from `baseSha`; if the branch moved in the meantime GitHub refuses and we
 * surface that as a stale error rather than overwriting someone else's work.
 */
export async function commitFiles(token, repo, { branch, baseSha, message, changes }) {
  const baseCommit = await gh(token, 'GET', `/repos/${repo}/git/commits/${baseSha}`);
  const entries = [];
  for (const change of changes) {
    if (change.action === 'delete') {
      entries.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await gh(token, 'POST', `/repos/${repo}/git/blobs`, { content: change.content, encoding: 'utf-8' });
    entries.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await gh(token, 'POST', `/repos/${repo}/git/trees`, { base_tree: baseCommit.tree.sha, tree: entries });
  const commit = await gh(token, 'POST', `/repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [baseSha] });
  try {
    await gh(token, 'PATCH', `/repos/${repo}/git/refs/heads/${refPath(branch)}`, { sha: commit.sha, force: false });
  } catch (err) {
    if (err.status === 422 || err.status === 409) throw new GitHubError('The branch changed on GitHub since this was proposed', 409);
    throw err;
  }
  return { sha: commit.sha, url: commit.html_url || `https://github.com/${repo}/commit/${commit.sha}` };
}

/** Ordered list of credentials that might work for this repo. Duplicates are dropped. */
export async function tokenCandidates(teamId, repo) {
  const out = [];
  const add = (kind, token) => { if (token && !out.some((c) => c.token === token)) out.push({ kind, token }); };
  const [owner, name] = repo ? repo.split('/') : [];
  if (owner && name) add('installation', await getRepoInstallationToken(owner, name).catch(() => null));
  const row = teamId ? queryOne('SELECT access_token, installation_id FROM github_integration WHERE team_id = ? AND connected = 1', teamId) : null;
  if (row?.installation_id) add('installation', await getInstallationToken(row.installation_id).catch(() => null));
  add('oauth', row?.access_token);
  add('server', GITHUB_TOKEN);
  return out;
}

/** Run `fn(token)` with each candidate credential until one is accepted. */
export async function withGithub(teamId, repo, fn) {
  const candidates = await tokenCandidates(teamId, repo);
  if (!candidates.length) throw new GitHubError('GitHub is not connected for this team. Connect it in Settings, Integrations.', 400);
  let last;
  for (const { token } of candidates) {
    try {
      return await fn(token);
    } catch (err) {
      last = err;
      if (!(err instanceof GitHubError) || ![401, 403, 404].includes(err.status)) throw err;
    }
  }
  throw new GitHubError(`${last?.message || 'Access denied'}. Check that the Morline GitHub App can write to this repository.`, last?.status || 403);
}

/**
 * Create a repository for the team's connected GitHub account. Personal accounts need the
 * user's own OAuth token; organisation accounts can also use the app installation token.
 */
export async function createRepoForTeam(teamId, { name, description, isPrivate = true }) {
  const row = queryOne('SELECT account, access_token, installation_id FROM github_integration WHERE team_id = ? AND connected = 1', teamId);
  if (!row) throw new GitHubError('GitHub is not connected for this team. Connect it in Settings, Integrations.', 400);
  const payload = { name, description: description || '', private: isPrivate, auto_init: true };

  const attempts = [];
  if (row.access_token) {
    attempts.push(async () => {
      const me = await gh(row.access_token, 'GET', '/user');
      const personal = !row.account || me.login.toLowerCase() === row.account.toLowerCase();
      return gh(row.access_token, 'POST', personal ? '/user/repos' : `/orgs/${row.account}/repos`, payload);
    });
  }
  if (row.installation_id && row.account) {
    attempts.push(async () => {
      const token = await getInstallationToken(row.installation_id);
      if (!token) throw new GitHubError('Could not mint an installation token', 401);
      return gh(token, 'POST', `/orgs/${row.account}/repos`, payload);
    });
  }
  if (!attempts.length) throw new GitHubError('Reconnect GitHub from Settings so Morline can create repositories for you.', 400);

  let last;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      last = err;
      if (!(err instanceof GitHubError) || err.status === 422) throw err;
    }
  }
  throw new GitHubError(`${last.message}. Reconnect GitHub from Settings to let Morline create repositories.`, last.status);
}
