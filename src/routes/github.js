import { Router } from 'express';
import { execute, queryOne } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validationError } from '../middleware/error-handler.js';

const router = Router();
router.use(requireAuth);

// GET /integrations/github
router.get('/', (req, res, next) => {
  try {
    const { teamId } = req.query;
    if (!teamId) throw validationError('teamId is required');

    const row = queryOne('SELECT * FROM github_integration WHERE team_id = ?', teamId);
    return res.json({
      connected: Boolean(row && row.connected),
      account: row?.account || null,
      installUrl: 'https://github.com/apps/moorline/installations/new'
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
router.get('/repos', (req, res, next) => {
  try {
    const { teamId, q } = req.query;
    if (!teamId) throw validationError('teamId is required');

    const repos = [
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
router.get('/repos/:owner/:repo/branches', (req, res) => {
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
