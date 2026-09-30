import { Router } from 'express';
import { execute, queryOne } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validationError, conflict } from '../middleware/error-handler.js';
import { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_NAME, GITHUB_TOKEN, PUBLIC_URL } from '../config.js';

const router = Router();

// OAuth Callback (public endpoint, called by GitHub redirect)
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state: teamId, error } = req.query;

    if (error) {
      return res.redirect(`${PUBLIC_URL}/settings/integrations?error=${encodeURIComponent(error)}`);
    }

    if (!code || !teamId) {
      throw validationError('Missing code or teamId state in GitHub callback');
    }

    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      throw validationError('GitHub OAuth credentials (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET) not configured on server');
    }

    // Exchange authorization code for user access token
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

    // Persist team integration token in database
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
  } catch (err) {
    next(err);
  }
});

// All endpoints below require authentication
router.use(requireAuth);

function getTeamToken(teamId) {
  if (!teamId) return null;
  const row = queryOne('SELECT access_token FROM github_integration WHERE team_id = ? AND connected = 1', teamId);
  return row?.access_token || GITHUB_TOKEN || null;
}

// GET /integrations/github
router.get('/', (req, res, next) => {
  try {
    const { teamId } = req.query;
    if (!teamId) throw validationError('teamId is required');

    const row = queryOne('SELECT * FROM github_integration WHERE team_id = ?', teamId);
    const connected = Boolean(row && row.connected && row.access_token);
    const account = row?.account || null;

    let installUrl = '';
    if (GITHUB_CLIENT_ID) {
      installUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=repo,read:user&state=${teamId}`;
    } else {
      installUrl = `https://github.com/apps/${GITHUB_APP_NAME}/installations/new?state=${teamId}`;
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

    const token = getTeamToken(teamId);
    if (!token) {
      throw conflict('GitHub account is not connected for this team. Please connect your GitHub account.', 'github_not_connected');
    }

    const ghRes = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Morline-Server',
        'Accept': 'application/vnd.github+json'
      }
    });

    if (!ghRes.ok) {
      const err = await ghRes.json().catch(() => ({}));
      throw conflict(`GitHub API error: ${err.message || ghRes.statusText}`, 'github_error');
    }

    const ghData = await ghRes.json();
    const repos = ghData.map((r) => ({
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

    const token = getTeamToken(teamId);
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
