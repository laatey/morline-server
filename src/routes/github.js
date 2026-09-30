import { Router } from 'express';
import { execute, queryOne } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validationError } from '../middleware/error-handler.js';
import { GITHUB_TOKEN, GITHUB_APP_NAME } from '../config.js';

const router = Router();
router.use(requireAuth);

// GET /integrations/github
router.get('/', async (req, res, next) => {
  try {
    const { teamId } = req.query;
    if (!teamId) throw validationError('teamId is required');

    const row = queryOne('SELECT * FROM github_integration WHERE team_id = ?', teamId);
    let connected = Boolean(row && row.connected);
    let account = row?.account || null;

    if (GITHUB_TOKEN && !connected) {
      try {
        const ghRes = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'User-Agent': 'Moorline-Server',
            'Accept': 'application/vnd.github+json'
          }
        });
        if (ghRes.ok) {
          const user = await ghRes.json();
          connected = true;
          account = user.login;
        }
      } catch (e) {}
    }

    return res.json({
      connected,
      account,
      installUrl: `https://github.com/apps/${GITHUB_APP_NAME}/installations/new`
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

    let repos = [];

    if (GITHUB_TOKEN) {
      try {
        const ghRes = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
          headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'User-Agent': 'Moorline-Server',
            'Accept': 'application/vnd.github+json'
          }
        });
        if (ghRes.ok) {
          const ghData = await ghRes.json();
          repos = ghData.map((r) => ({
            fullName: r.full_name,
            private: r.private,
            defaultBranch: r.default_branch || 'main',
            updatedAt: r.updated_at,
            alreadyDeployedIn: []
          }));
        }
      } catch (e) {
        console.error('[GitHub] Error fetching live repos:', e.message);
      }
    }

    if (repos.length === 0) {
      repos = [
        {
          fullName: 'morline-org/sample-node-api',
          private: false,
          defaultBranch: 'main',
          updatedAt: new Date().toISOString(),
          alreadyDeployedIn: []
        },
        {
          fullName: 'morline-org/sample-nextjs-app',
          private: false,
          defaultBranch: 'main',
          updatedAt: new Date().toISOString(),
          alreadyDeployedIn: []
        },
        {
          fullName: 'morline-org/fastapi-backend',
          private: true,
          defaultBranch: 'main',
          updatedAt: new Date().toISOString(),
          alreadyDeployedIn: []
        },
        {
          fullName: 'morline-org/vite-react-spa',
          private: false,
          defaultBranch: 'main',
          updatedAt: new Date().toISOString(),
          alreadyDeployedIn: []
        }
      ];
    }

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
router.get('/repos/:owner/:repo/branches', async (req, res) => {
  const { owner, repo } = req.params;

  if (GITHUB_TOKEN) {
    try {
      const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches`, {
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'User-Agent': 'Moorline-Server',
          'Accept': 'application/vnd.github+json'
        }
      });
      if (ghRes.ok) {
        const branches = await ghRes.json();
        return res.json({
          data: branches.map((b) => ({
            name: b.name,
            default: b.name === 'main' || b.name === 'master',
            sha: b.commit?.sha || 'unknown'
          }))
        });
      }
    } catch (e) {
      console.error('[GitHub] Error fetching live branches:', e.message);
    }
  }

  return res.json({
    data: [
      { name: 'main', default: true, sha: '8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a' },
      { name: 'staging', default: false, sha: '7e6f5a4b3c2d1e0f9a8f7a6b5c4d3e2f1a0b9c8d' },
      { name: 'feat/canvas-redesign', default: false, sha: '6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c' }
    ]
  });
});

// GET /integrations/github/repos/:owner/:repo/detect
router.get('/repos/:owner/:repo/detect', (req, res) => {
  const repoName = req.params.repo.toLowerCase();

  let logo = 'js';
  let framework = 'Node.js Express';
  let buildCommand = 'npm install';
  let startCommand = 'node server.js';
  let port = 3000;
  let suggestedVariables = ['PORT', 'NODE_ENV'];

  if (repoName.includes('next')) {
    logo = 'nextjs';
    framework = 'Next.js';
    buildCommand = 'npm install && npm run build';
    startCommand = 'npm run start';
    suggestedVariables = ['NODE_ENV', 'PORT'];
  } else if (repoName.includes('python') || repoName.includes('fastapi')) {
    logo = 'python';
    framework = 'FastAPI';
    buildCommand = 'pip install -r requirements.txt';
    startCommand = 'uvicorn main:app --host 0.0.0.0 --port $PORT';
    port = 8000;
    suggestedVariables = ['PORT', 'PYTHONUNBUFFERED'];
  } else if (repoName.includes('vite') || repoName.includes('react')) {
    logo = 'vite';
    framework = 'Vite + React';
    buildCommand = 'npm install && npm run build';
    startCommand = 'npm run preview';
    suggestedVariables = ['NODE_ENV'];
  } else if (repoName.includes('go')) {
    logo = 'go';
    framework = 'Go';
    buildCommand = 'go build -o app';
    startCommand = './app';
    port = 8080;
    suggestedVariables = ['PORT'];
  } else if (repoName.includes('rust')) {
    logo = 'rust';
    framework = 'Rust Axum';
    buildCommand = 'cargo build --release';
    startCommand = './target/release/app';
    port = 8080;
    suggestedVariables = ['PORT', 'RUST_LOG'];
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
