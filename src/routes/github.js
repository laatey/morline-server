import { Router } from 'express';
import crypto from 'node:crypto';
import { execute, queryOne, queryAll } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validationError, conflict } from '../middleware/error-handler.js';
import { GITHUB_APP_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_NAME, GITHUB_PRIVATE_KEY, GITHUB_TOKEN, PUBLIC_URL, FRONTEND_URL } from '../config.js';
import { buildManager } from '../engine/build-manager.js';
import { signOAuthState, verifyOAuthState } from '../services/oauth-state.js';
import { verifyWebhookSignature } from '../services/github-webhook.js';
import { GITHUB_WEBHOOK_SECRET } from '../config.js';
import {
  generateGitHubAppJwt,
  getInstallationToken,
  getRepoInstallationToken,
  listAppInstallations,
  listInstallationRepositories
} from '../services/github-app.js';

const router = Router();

function renderPopupSuccess(res) {
  return res.send(`<!DOCTYPE html>
<html>
<head><title>GitHub Connected</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #090a0f; color: #fff;">
  <div style="text-align: center;">
    <div style="font-size: 28px; margin-bottom: 8px; color: #22c55e;">✓</div>
    <h3 style="margin: 0 0 8px 0; font-size: 16px;">Connected to GitHub</h3>
    <p style="margin: 0; color: #888; font-size: 13px;">This window will close automatically...</p>
  </div>
  <script>
    if (window.opener) {
      try { window.opener.postMessage({ type: 'github_connected' }, '*'); } catch (e) {}
    }
    setTimeout(function() { window.close(); }, 1000);
  </script>
</body>
</html>`);
}

// Callback (public endpoint, called by GitHub redirect for OAuth or App Installation)
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state, installation_id, setup_action, error } = req.query;
    const teamId = verifyOAuthState(state); // null unless Morline signed this state

    if (error) {
      return res.redirect(`${FRONTEND_URL}/settings/integrations?error=${encodeURIComponent(error)}`);
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

      const targetTeamId = teamId;
      if (!targetTeamId) {
        return res.redirect(`${FRONTEND_URL}/settings/integrations?error=${encodeURIComponent('Missing teamId in GitHub installation callback state')}`);
      }
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

      return renderPopupSuccess(res);
    }

    // Case 2: OAuth Code Exchange callback
    if (code) {
      if (!teamId) { // not one of our signed team states: it's a sign-in OAuth callback
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
        return res.redirect(`${FRONTEND_URL}/settings/integrations?error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`);
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

      // Check if user already has GitHub App installed
      let installationId = null;
      try {
        const installations = await listAppInstallations();
        const match = installations.find(i => i.account?.login?.toLowerCase() === account.toLowerCase());
        if (match) {
          installationId = match.id;
        }
      } catch (e) {
        console.error('[GitHub App] Error checking installations in oauth callback:', e.message);
      }

      execute(`
        INSERT INTO github_integration (team_id, account, install_url, access_token, installation_id, connected, connected_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(team_id) DO UPDATE SET
          account = excluded.account,
          access_token = excluded.access_token,
          installation_id = COALESCE(excluded.installation_id, github_integration.installation_id),
          connected = 1,
          connected_at = excluded.connected_at
      `, teamId, account, `https://github.com/${account}`, accessToken, installationId, now);

      // If GitHub App is configured and not yet installed by this user, guide them to install it
      if (!installationId && GITHUB_APP_NAME) {
        return res.redirect(`https://github.com/apps/${GITHUB_APP_NAME}/installations/new?state=${encodeURIComponent(signOAuthState(teamId))}`);
      }

      return renderPopupSuccess(res);
    }

    throw validationError('Missing code or installation_id in GitHub callback');
  } catch (err) {
    next(err);
  }
});

// POST /integrations/github/webhook (public webhook endpoint from GitHub)
router.post('/webhook', async (req, res) => {
  if (!GITHUB_WEBHOOK_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'GITHUB_WEBHOOK_SECRET is not configured; refusing unsigned webhooks' });
    }
  } else if (!verifyWebhookSignature(GITHUB_WEBHOOK_SECRET, req.rawBody, req.headers['x-hub-signature-256'])) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
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
    // The assistant starts its own deployment when it commits; GitHub then echoes the push.
    const sha = head_commit?.id;
    if (sha && queryOne('SELECT 1 AS x FROM deployments WHERE service_id = ? AND commit_sha = ? AND state != \'failed\'', srv.id, sha)) continue;
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
  return row?.access_token || null;
}

// GET /integrations/github
router.get('/', async (req, res, next) => {
  try {
    const { teamId } = req.query;
    if (!teamId) throw validationError('teamId is required');

    let row = queryOne('SELECT * FROM github_integration WHERE team_id = ?', teamId);
    let connected = Boolean(row && row.connected && (row.access_token || row.installation_id));
    let account = row?.account || null;

    // If not connected yet or missing installation_id, try auto-discovering from app installations for current user
    if ((!connected || !row?.installation_id) && req.user) {
      let knownLogin = null;
      if (req.user.email?.endsWith('@github.morline.space')) {
        knownLogin = req.user.email.split('@')[0];
      } else if (account) {
        knownLogin = account;
      } else if (req.user.username && !req.user.username.startsWith('usr_')) {
        // e.g. username created from github login
        knownLogin = req.user.username.replace(/[0-9]+$/, '');
      }

      if (knownLogin) {
        try {
          const installations = await listAppInstallations();
          const match = installations.find(i => 
            i.account?.login?.toLowerCase() === knownLogin.toLowerCase()
          );
          if (match) {
            const now = new Date().toISOString();
            execute(`
              INSERT INTO github_integration (team_id, account, install_url, installation_id, connected, connected_at)
              VALUES (?, ?, ?, ?, 1, ?)
              ON CONFLICT(team_id) DO UPDATE SET
                account = excluded.account,
                installation_id = excluded.installation_id,
                connected = 1,
                connected_at = excluded.connected_at
            `, teamId, match.account.login, `https://github.com/apps/${GITHUB_APP_NAME}/installations/new`, match.id, now);
            connected = true;
            account = match.account.login;
          }
        } catch (e) {
          console.error('[GitHub auto-sync error]:', e.message);
        }
      }
    }

    // Prefer OAuth authorize first: if user already has app installed, it connects seamlessly without asking to reinstall!
    let installUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=repo,read:user&state=${encodeURIComponent(signOAuthState(teamId))}`;
    if (!GITHUB_CLIENT_ID && GITHUB_APP_NAME) {
      installUrl = `https://github.com/apps/${GITHUB_APP_NAME}/installations/new?state=${encodeURIComponent(signOAuthState(teamId))}`;
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
    } else if (row?.access_token) {
      const ghRes = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
        headers: {
          'Authorization': `Bearer ${row.access_token}`,
          'User-Agent': 'Morline-Server',
          'Accept': 'application/vnd.github+json'
        }
      });
      if (ghRes.ok) {
        rawRepos = await ghRes.json();
      }
    } else {
      return res.json({
        data: [],
        nextCursor: null
      });
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
