import { Router } from 'express';
import crypto from 'node:crypto';
import { execute, queryOne, queryAll } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validationError, conflict } from '../middleware/error-handler.js';
import { GITHUB_APP_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_NAME, GITHUB_PRIVATE_KEY, GITHUB_TOKEN, PUBLIC_URL } from '../config.js';
import { buildManager } from '../engine/build-manager.js';
import {
  generateGitHubAppJwt,
  getInstallationToken,
  getRepoInstallationToken,
  listAppInstallations,
  listInstallationRepositories
} from '../services/github-app.js';

const router = Router();

// Callback (public endpoint, called by GitHub redirect for OAuth or App Installation)
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state: teamId, installation_id, setup_action, error } = req.query;

    if (error) {
      return res.redirect(`${PUBLIC_URL}/settings/integrations?error=${encodeURIComponent(error)}`);
    }

    // Case 1: GitHub App Installation callback
    if (installation_id) {
      const instId = parseInt(installation_id, 10);
      let account = 'GitHub Account';
      const jwt = generateGitHubAppJwt();
      if (jwt) {
        try {
          const r = await fetch(`https://api.github.com/app/installations/${instId}`, {
            headers: {
              'Authorization': `Bearer ${jwt}`,
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'Morline-App'
            }
          });
          if (r.ok) {
            const data = await r.json();
            account = data.account?.login || account;
          }
        } catch (e) {
          console.error('[GitHub App] Error fetching installation details:', e.message);
        }
      }

      const targetTeamId = teamId || queryOne('SELECT id FROM teams ORDER BY created_at ASC')?.id || 'team_default';
      const now = new Date().toISOString();

      execute(`
        INSERT INTO github_integration (team_id, account, install_url, installation_id, connected, connected_at)
        VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(team_id) DO UPDATE SET
          account = excluded.account,
          installation_id = excluded.installation_id,
          connected = 1,
          connected_at = excluded.connected_at
      `, targetTeamId, account, `https://github.com/apps/${GITHUB_APP_NAME}/installations/new`, instId, now);

      return res.redirect(`${PUBLIC_URL}/settings/integrations?github_connected=true`);
    }

    // Case 2: OAuth Code Exchange callback
    if (code) {
      if (!teamId || teamId.startsWith('http') || teamId.includes('{') || teamId.length > 32) {
        const { handleGitHubOAuthCallback } = await import('./auth.js');
        return handleGitHubOAuthCallback(req, res);
      }

      if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
        throw validationError('GitHub OAuth credentials (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET) not configured on server');
      }

      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Morline-Server'
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code
        })
      });

      const tokenData = await tokenRes.json();
      if (tokenData.error) {
        return res.redirect(`${PUBLIC_URL}/settings/integrations?error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`);
      }

      const accessToken = tokenData.access_token;

      // Fetch authenticated user info
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': 'Morline-Server',
          'Accept': 'application/vnd.github+json'
        }
      });

      const ghUser = await userRes.json();
      const account = ghUser.login || 'GitHub User';
      const now = new Date().toISOString();

      execute(`
        INSERT INTO github_integration (team_id, account, install_url, access_token, connected, connected_at)
        VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(team_id) DO UPDATE SET
          account = excluded.account,
          access_token = excluded.access_token,
          connected = 1,
          connected_at = excluded.connected_at
      `, teamId, account, `https://github.com/${account}`, accessToken, now);

      return res.redirect(`${PUBLIC_URL}/settings/integrations?github_connected=true`);
    }

    throw validationError('Missing code or installation_id in GitHub callback');
  } catch (err) {
    next(err);
  }
});

// POST /integrations/github/webhook (public webhook endpoint from GitHub)
router.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  if (event !== 'push') {
    return res.status(200).json({ received: true, ignored: `Event ${event} not handled` });
  }

  const { repository, ref, head_commit } = req.body || {};
  if (!repository?.full_name || !ref) {
    return res.status(400).json({ error: 'Invalid push payload' });
  }

  const branch = ref.replace('refs/heads/', '');
  const repoName = repository.full_name;

  // Find any service tracking this repo and branch with auto_deploy enabled
  const matchingServices = queryAll(`
    SELECT s.id, s.name, s.environment_id 
    FROM services s
    JOIN service_settings ss ON ss.service_id = s.id
    WHERE (s.source_repo = ? OR s.source_repo = ?) 
      AND (s.source_branch = ? OR ss.branch = ? OR (s.source_branch IS NULL AND ? = 'main'))
      AND ss.auto_deploy = 1
  `, repoName, repository.name, branch, branch, branch);

  for (const srv of matchingServices) {
    const deploymentId = `dep_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    execute(`
      INSERT INTO deployments (id, service_id, service_name, environment_id, state, trigger, commit_sha, commit_message, commit_author, commit_branch, created_at)
      VALUES (?, ?, ?, ?, 'queued', 'webhook', ?, ?, ?, ?, ?)
    `, deploymentId, srv.id, srv.name, srv.environment_id,
      head_commit?.id || null, head_commit?.message || 'Automatic push deployment',
      head_commit?.author?.name || 'GitHub', branch, now);

    buildManager.buildAndDeploy(srv.id, deploymentId).catch(err => {
      console.error(`[Webhook Deploy Error] Service ${srv.name}:`, err.message);
    });
  }

  return res.status(200).json({
    triggered: matchingServices.length,
    services: matchingServices.map(s => s.name)
  });
});

// All endpoints below require authentication
router.use(requireAuth);

async function getTeamToken(teamId) {
  if (!teamId) return null;
  const row = queryOne('SELECT access_token, installation_id FROM github_integration WHERE team_id = ? AND connected = 1', teamId);
  if (row?.installation_id) {
    const instToken = await getInstallationToken(row.installation_id);
    if (instToken) return instToken;
  }
  return row?.access_token || GITHUB_TOKEN || null;
}

// GET /integrations/github
router.get('/', async (req, res, next) => {
  try {
    const { teamId } = req.query;
    if (!teamId) throw validationError('teamId is required');

    let row = queryOne('SELECT * FROM github_integration WHERE team_id = ?', teamId);
    let connected = Boolean(row && row.connected && (row.access_token || row.installation_id));
    let account = row?.account || null;

    // If not directly recorded for this team, check if there's already an active GitHub App installation
    if (!connected && GITHUB_APP_ID && GITHUB_PRIVATE_KEY) {
      const installations = await listAppInstallations();
      if (installations.length > 0) {
        const inst = installations[0];
        account = inst.account?.login || 'GitHub Account';
        const now = new Date().toISOString();
        execute(`
          INSERT INTO github_integration (team_id, account, install_url, installation_id, connected, connected_at)
          VALUES (?, ?, ?, ?, 1, ?)
          ON CONFLICT(team_id) DO UPDATE SET
            account = excluded.account,
            installation_id = excluded.installation_id,
            connected = 1,
            connected_at = excluded.connected_at
        `, teamId, account, `https://github.com/apps/${GITHUB_APP_NAME}/installations/new`, inst.id, now);
        connected = true;
      }
    }

    let installUrl = `https://github.com/apps/${GITHUB_APP_NAME}/installations/new?state=${teamId}`;
    if (!GITHUB_APP_NAME && GITHUB_CLIENT_ID) {
      installUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=repo,read:user&state=${teamId}`;
    }

    return res.json({
      connected,
      account,
      installUrl
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /integrations/github
router.delete('/', (req, res, next) => {
  try {
    const { teamId } = req.query;
    if (!teamId) throw validationError('teamId is required');

    execute('DELETE FROM github_integration WHERE team_id = ?', teamId);
    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /integrations/github/repos
router.get('/repos', async (req, res, next) => {
  try {
    const { teamId, q } = req.query;
    if (!teamId) throw validationError('teamId is required');

    let row = queryOne('SELECT access_token, installation_id FROM github_integration WHERE team_id = ? AND connected = 1', teamId);
    let rawRepos = [];

    if (row?.installation_id) {
      rawRepos = await listInstallationRepositories(row.installation_id);
    } else if (row?.access_token || GITHUB_TOKEN) {
      const token = row?.access_token || GITHUB_TOKEN;
      const ghRes = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Morline-Server',
          'Accept': 'application/vnd.github+json'
        }
      });
      if (ghRes.ok) {
        rawRepos = await ghRes.json();
      }
    } else {
      // Check if any app installations exist on account
      const installations = await listAppInstallations();
      if (installations.length > 0) {
        rawRepos = await listInstallationRepositories(installations[0].id);
      } else {
        throw conflict('GitHub account is not connected for this team. Please connect your GitHub account.', 'github_not_connected');
      }
    }

    const repos = rawRepos.map((r) => ({
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch || 'main',
      updatedAt: r.updated_at,
      alreadyDeployedIn: []
    }));

    const filtered = q ? repos.filter(r => r.fullName.toLowerCase().includes(q.toLowerCase())) : repos;

    return res.json({
      data: filtered,
      nextCursor: null
    });
  } catch (err) {
    next(err);
  }
});

// GET /integrations/github/repos/:owner/:repo/branches
router.get('/repos/:owner/:repo/branches', async (req, res, next) => {
  try {
    const { owner, repo } = req.params;
    const { teamId } = req.query;

    let token = await getTeamToken(teamId);
    if (!token) {
      token = await getRepoInstallationToken(owner, repo);
    }

    if (!token) {
      throw conflict('GitHub account is not connected for this team.', 'github_not_connected');
    }

    const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Morline-Server',
        'Accept': 'application/vnd.github+json'
      }
    });

    if (!ghRes.ok) {
      const err = await ghRes.json().catch(() => ({}));
      throw conflict(`GitHub error: ${err.message || ghRes.statusText}`, 'github_error');
    }

    const branches = await ghRes.json();
    return res.json({
      data: branches.map((b) => ({
        name: b.name,
        default: b.name === 'main' || b.name === 'master',
        sha: b.commit?.sha || 'unknown'
      }))
    });
  } catch (err) {
    next(err);
  }
});

// GET /integrations/github/repos/:owner/:repo/detect
router.get('/repos/:owner/:repo/detect', async (req, res) => {
  const { owner, repo } = req.params;
  const { teamId } = req.query;
  const token = getTeamToken(teamId);

  let logo = 'js';
  let framework = 'Node.js';
  let buildCommand = 'npm install';
  let startCommand = 'node server.js';
  let port = 3000;
  let suggestedVariables = ['PORT', 'NODE_ENV'];

  if (token) {
    try {
      const contentRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Morline-Server',
          'Accept': 'application/vnd.github+json'
        }
      });

      if (contentRes.ok) {
        const items = await contentRes.json();
        const fileNames = Array.isArray(items) ? items.map(i => i.name.toLowerCase()) : [];

        if (fileNames.includes('package.json')) {
          logo = 'js';
          framework = 'Node.js';
          buildCommand = 'npm install';
          startCommand = 'npm start';

          // Try inspecting package.json for Next.js / Vite
          const pkgItem = items.find(i => i.name.toLowerCase() === 'package.json');
          if (pkgItem?.download_url) {
            const pkgRes = await fetch(pkgItem.download_url);
            if (pkgRes.ok) {
              const pkg = await pkgRes.json();
              const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
              if (allDeps.next) {
                logo = 'nextjs';
                framework = 'Next.js';
                buildCommand = 'npm install && npm run build';
                startCommand = 'npm run start';
              } else if (allDeps.vite) {
                logo = 'vite';
                framework = 'Vite';
                buildCommand = 'npm install && npm run build';
                startCommand = 'npm run preview';
              } else if (pkg.scripts?.start) {
                startCommand = 'npm start';
              } else if (pkg.main) {
                startCommand = `node ${pkg.main}`;
              }
            }
          }
        } else if (fileNames.includes('requirements.txt') || fileNames.includes('pyproject.toml')) {
          logo = 'python';
          framework = 'Python';
          buildCommand = 'pip install -r requirements.txt';
          startCommand = fileNames.includes('main.py') ? 'python main.py' : 'uvicorn main:app --host 0.0.0.0 --port $PORT';
          port = 8000;
          suggestedVariables = ['PORT', 'PYTHONUNBUFFERED'];
        } else if (fileNames.includes('go.mod')) {
          logo = 'go';
          framework = 'Go';
          buildCommand = 'go build -o app';
          startCommand = './app';
          port = 8080;
        } else if (fileNames.includes('cargo.toml')) {
          logo = 'rust';
          framework = 'Rust';
          buildCommand = 'cargo build --release';
          startCommand = './target/release/app';
          port = 8080;
        }
      }
    } catch (e) {
      console.error('[GitHub Detect] Error inspecting repository:', e.message);
    }
  }

  return res.json({
    logo,
    framework,
    buildCommand,
    startCommand,
    port,
    suggestedVariables
  });
});

export default router;
