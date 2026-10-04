import { spawn } from 'node:child_process';

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Accepts "owner/repo", "https://github.com/owner/repo(.git)", "git@github.com:owner/repo.git"
 * and "https://github.com/owner/repo/tree/<branch>[/<subfolder>]".
 * Returns { repo, refAndPath } where refAndPath is everything after /tree/ (or null).
 */
export function parseGithubUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim().replace(/[?#].*$/, '');
  s = s.replace(/^git@github\.com:/, '').replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repo = `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
  if (!SLUG.test(repo)) return null;
  const refAndPath = parts[2] === 'tree' && parts.length > 3 ? parts.slice(3).join('/') : null;
  return { repo, refAndPath };
}

function lsRemote(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn('git', ['ls-remote', ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'ignore']
    });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

/** The branch a public repository's HEAD points at (its default branch), or null if unknown. */
export async function defaultBranchOf(repo) {
  const out = await lsRemote(['--symref', `https://github.com/${repo}.git`, 'HEAD']);
  return /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(out || '')?.[1] || null;
}

/**
 * Splits "<branch>/<subfolder>" from a /tree/ URL. Branch names may contain slashes, so the
 * longest real branch that prefixes the path wins; if GitHub can't be asked, the first
 * segment is taken as the branch.
 */
export async function splitTreePath(repo, refAndPath) {
  const segments = refAndPath.split('/');
  const out = await lsRemote(['--heads', `https://github.com/${repo}.git`]);
  if (out) {
    const branches = out.split('\n').map((l) => l.split('\trefs/heads/')[1]).filter(Boolean);
    let best = null;
    for (const b of branches) {
      if ((refAndPath === b || refAndPath.startsWith(`${b}/`)) && (!best || b.length > best.length)) best = b;
    }
    if (best) return { branch: best, path: refAndPath.slice(best.length).replace(/^\//, '') || null };
  }
  return { branch: segments[0], path: segments.slice(1).join('/') || null };
}

/** One call for the creation routes: { repo, branch|null, rootDirectory|null } or null if not a GitHub URL. */
export async function resolveGithubSource(input) {
  const parsed = parseGithubUrl(input);
  if (!parsed) return null;
  if (!parsed.refAndPath) return { repo: parsed.repo, branch: null, rootDirectory: null };
  const { branch, path } = await splitTreePath(parsed.repo, parsed.refAndPath);
  return { repo: parsed.repo, branch, rootDirectory: path };
}
