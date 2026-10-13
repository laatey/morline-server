import { destroyService } from './service-cleanup.js';
import crypto from 'node:crypto';
import { execute, queryOne } from '../db/index.js';
import { mapAction } from '../db/mappers.js';
import { AppError, forbidden, notFound } from '../middleware/error-handler.js';
import { GitHubError, withGithub, createRepoForTeam, getRepo, getBranchHead, commitFiles, createBranch, createPullRequest } from './github-repo.js';
import { createRepoService, startDeployment, writeWorkspaceFiles } from './service-factory.js';
import { slugify } from './builder/files.js';

const WRITE_ROLES = new Set(['owner', 'admin', 'member']);
const rid = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (s, fallback = null) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

export function createAction({ messageId, threadId, type, title, description = '', risk = 'medium', reversible = true, targets = [], payload, diff }) {
  const id = rid('act');
  execute(`
    INSERT INTO assistant_actions (id, message_id, thread_id, type, status, title, description, risk, reversible, targets, payload, diff, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
  `, id, messageId, threadId, type, title, description, risk, reversible ? 1 : 0, json(targets), json(payload), json(diff), new Date().toISOString());
  return id;
}

/** Row -> API shape. File bodies stay server-side; the UI only needs the diff. */
export function publicAction(row) {
  const action = mapAction(row);
  if (!action) return null;
  const p = action.payload || {};
  action.payload = {
    repo: p.repo, branch: p.branch, mode: p.mode, serviceId: p.serviceId, name: p.name, port: p.port,
    envVars: p.envVars, volume: p.volume, fileCount: (p.files || p.changes || []).length,
    deploy: p.deploy, githubConnected: row.type === 'create_app' ? githubConnected(teamOf(row)?.team_id) : undefined
  };
  return action;
}

export function githubConnected(teamId) {
  return Boolean(queryOne('SELECT 1 AS ok FROM github_integration WHERE team_id = ? AND connected = 1', teamId));
}

function teamOf(row) {
  return queryOne(`
    SELECT p.team_id, p.id AS project_id FROM assistant_threads t JOIN projects p ON p.id = t.project_id WHERE t.id = ?
  `, row.thread_id);
}

function requireWriteAccess(row, user) {
  const t = teamOf(row);
  if (!t) throw notFound('This conversation no longer belongs to a project');
  const role = queryOne('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', t.team_id, user.id)?.role;
  if (!WRITE_ROLES.has(role)) throw forbidden('Viewers cannot apply changes');
  return t;
}

const update = (id, fields) => {
  const cols = Object.keys(fields);
  execute(`UPDATE assistant_actions SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => fields[c]), id);
};

/** Claim an action for work so two clicks can't run it twice. */
function claim(row, fromStatuses) {
  const marks = fromStatuses.map(() => '?').join(',');
  const res = execute(`UPDATE assistant_actions SET status = 'applying' WHERE id = ? AND status IN (${marks})`, row.id, ...fromStatuses);
  if (!res.changes) throw new AppError('This action is no longer available', 409, 'action_stale');
}

function describeError(err) {
  if (err instanceof GitHubError && /protected branch|required status|review/i.test(err.message)) return `${err.message}. This branch is protected, so open a pull request instead.`;
  if (err instanceof GitHubError || err instanceof AppError) return err.message;
  return err?.message || 'Something went wrong';
}

// --- create_app ----------------------------------------------------------------------------

async function runCreateApp(row, user, team) {
  const payload = parse(row.payload, {});
  const result = parse(row.result, {}) || {};
  const save = () => update(row.id, { result: json(result) });

  const direct = payload.deploy === 'direct';
  const variablesFor = () => {
    const variables = (payload.envVars || [])
      .filter((v) => v.generate)
      .map((v) => ({ key: v.key, value: crypto.randomBytes(24).toString('hex'), secret: true }));
    if (payload.volume) variables.push({ key: 'DATA_DIR', value: payload.volume.mountPath, secret: false });
    return variables;
  };

  if (direct) {
    // No GitHub: the files go straight into the service's build workspace.
    if (!result.serviceId) {
      const variables = variablesFor();
      const service = createRepoService({
        environmentId: payload.environmentId, name: slugify(payload.name), repo: null,
        branch: null, port: payload.port, variables, volume: payload.volume
      });
      result.serviceId = service.id;
      result.generatedVariables = variables.map((v) => v.key);
      save();
    }
    if (!result.filesWritten) {
      writeWorkspaceFiles(result.serviceId, payload.files);
      result.filesWritten = true;
      save();
    }
  } else {
    if (!githubConnected(team.team_id)) throw new GitHubError('GitHub is not connected for this team. Connect it, or choose to deploy without GitHub.', 400);
    if (!result.repo) {
      const base = slugify(payload.name);
      let created;
      for (let i = 1; i <= 6 && !created; i++) {
        try {
          created = await createRepoForTeam(team.team_id, { name: i === 1 ? base : `${base}-${i}`, description: payload.description, isPrivate: true });
        } catch (err) {
          if (!(err instanceof GitHubError) || err.status !== 422 || i === 6) throw err;
        }
      }
      result.repo = { fullName: created.full_name, url: created.html_url, branch: created.default_branch || 'main' };
      save();
    }

    if (!result.commitSha) {
      const { fullName, branch } = result.repo;
      // A fresh repository can take a moment before its first ref is readable.
      let head;
      for (let i = 0; i < 5 && !head; i++) {
        try { head = await withGithub(team.team_id, fullName, (t) => getBranchHead(t, fullName, branch)); }
        catch (err) { if (i === 4) throw err; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
      }
      const commit = await withGithub(team.team_id, fullName, (t) => commitFiles(t, fullName, {
        branch, baseSha: head, message: `Initial version: ${payload.name}\n\nGenerated with Morline`,
        changes: payload.files.map((f) => ({ path: f.path, action: 'create', content: f.content }))
      }));
      result.commitSha = commit.sha;
      result.commitUrl = commit.url;
      save();
    }

    if (!result.serviceId) {
      const variables = variablesFor();
      const service = createRepoService({
        environmentId: payload.environmentId, name: slugify(payload.name), repo: result.repo.fullName,
        branch: result.repo.branch, port: payload.port, variables, volume: payload.volume
      });
      result.serviceId = service.id;
      result.generatedVariables = variables.map((v) => v.key);
      save();
    }
  }

  if (!result.deploymentId) {
    result.deploymentId = startDeployment({
      serviceId: result.serviceId, userId: user.id, commitSha: result.commitSha || null,
      message: `Initial version: ${payload.name}`, branch: result.repo?.branch || null
    });
    save();
  }
  return result;
}

async function revertCreateApp(row) {
  const result = parse(row.result, {}) || {};
  if (result.serviceId) {
    await destroyService(result.serviceId);
  }
  return { ...result, serviceRemoved: true };
}

// --- modify_code ---------------------------------------------------------------------------

const toCommitChanges = (changes) => changes.map((c) => ({ path: c.path, action: c.action, content: c.after }));

async function runModifyCode(row, user, team) {
  const p = parse(row.payload, {});
  const result = parse(row.result, {}) || {};
  const message = `${p.message}\n\nProposed by the Morline assistant, applied by ${user.name || user.email}`;

  if (p.mode === 'pr') {
    const branch = `morline/${slugify(p.message, 'change').slice(0, 30)}-${row.id.slice(-6)}`;
    const out = await withGithub(team.team_id, p.repo, async (t) => {
      const head = await getBranchHead(t, p.repo, p.branch);
      if (head !== p.baseSha) throw new GitHubError('The branch changed on GitHub since this was proposed. Ask for the change again.', 409);
      await createBranch(t, p.repo, branch, p.baseSha);
      const commit = await commitFiles(t, p.repo, { branch, baseSha: p.baseSha, message, changes: toCommitChanges(p.changes) });
      const pr = await createPullRequest(t, p.repo, { title: p.message.slice(0, 120), head: branch, base: p.branch, body: p.summary || '' });
      return { commit, pr };
    });
    return { ...result, branch, commitSha: out.commit.sha, commitUrl: out.commit.url, pullRequestUrl: out.pr.html_url, pullRequestNumber: out.pr.number };
  }

  const commit = await withGithub(team.team_id, p.repo, async (t) => {
    const head = await getBranchHead(t, p.repo, p.branch);
    if (head !== p.baseSha) throw new GitHubError('The branch changed on GitHub since this was proposed. Ask for the change again.', 409);
    return commitFiles(t, p.repo, { branch: p.branch, baseSha: p.baseSha, message, changes: toCommitChanges(p.changes) });
  });
  const next = { ...result, commitSha: commit.sha, commitUrl: commit.url };
  if (p.serviceId && queryOne('SELECT 1 AS x FROM services WHERE id = ?', p.serviceId)) {
    next.deploymentId = startDeployment({ serviceId: p.serviceId, userId: user.id, commitSha: commit.sha, message: p.message, branch: p.branch });
  }
  return next;
}

async function revertModifyCode(row, user, team) {
  const p = parse(row.payload, {});
  const result = parse(row.result, {}) || {};
  if (p.mode === 'pr') throw new AppError('Close the pull request on GitHub to undo this', 409, 'action_not_reversible');
  const undo = p.changes.map((c) => c.action === 'create'
    ? { path: c.path, action: 'delete' }
    : { path: c.path, action: c.action === 'delete' ? 'create' : 'update', content: c.before });
  const commit = await withGithub(team.team_id, p.repo, async (t) => {
    const head = await getBranchHead(t, p.repo, p.branch);
    if (head !== result.commitSha) throw new GitHubError('The branch has new commits since this change, so it cannot be undone automatically', 409);
    return commitFiles(t, p.repo, { branch: p.branch, baseSha: head, message: `Revert: ${p.message}`, changes: undo });
  });
  const next = { ...result, revertCommitSha: commit.sha, revertCommitUrl: commit.url };
  if (p.serviceId && queryOne('SELECT 1 AS x FROM services WHERE id = ?', p.serviceId)) {
    next.revertDeploymentId = startDeployment({ serviceId: p.serviceId, userId: user.id, commitSha: commit.sha, message: `Revert: ${p.message}`, branch: p.branch });
  }
  return next;
}

// --- public entry points -------------------------------------------------------------------

const EXECUTORS = {
  create_app: { apply: runCreateApp, revert: revertCreateApp },
  modify_code: { apply: runModifyCode, revert: revertModifyCode }
};

export async function applyAction(row, user) {
  const exec = EXECUTORS[row.type];
  if (!exec) throw new AppError(`Unknown action type: ${row.type}`, 400, 'action_unsupported');
  const team = requireWriteAccess(row, user);
  claim(row, ['pending', 'failed']);
  try {
    const result = await exec.apply(queryOne('SELECT * FROM assistant_actions WHERE id = ?', row.id), user, team);
    update(row.id, { status: 'applied', result: json(result), applied_at: new Date().toISOString(), applied_by: json({ id: user.id, name: user.name || null, email: user.email }) });
  } catch (err) {
    const prev = parse(queryOne('SELECT result FROM assistant_actions WHERE id = ?', row.id)?.result, {}) || {};
    // A stale branch means the proposal is dead; anything else can be retried from where it stopped.
    update(row.id, { status: err.status === 409 ? 'dismissed' : 'failed', result: json({ ...prev, error: describeError(err) }) });
    if (err.status === 409) throw new AppError(describeError(err), 409, 'action_stale');
    if (err instanceof AppError) throw err;
    throw new AppError(describeError(err), err.status && err.status < 500 ? err.status : 502, 'action_failed');
  }
  return queryOne('SELECT * FROM assistant_actions WHERE id = ?', row.id);
}

export async function revertAction(row, user) {
  const exec = EXECUTORS[row.type];
  if (!exec || !row.reversible) throw new AppError('This action cannot be reverted', 409, 'action_not_reversible');
  const team = requireWriteAccess(row, user);
  claim(row, ['applied']);
  try {
    const result = await exec.revert(row, user, team);
    update(row.id, { status: 'reverted', result: json(result) });
  } catch (err) {
    const prev = parse(row.result, {}) || {};
    update(row.id, { status: 'applied', result: json({ ...prev, revertError: describeError(err) }) });
    if (err instanceof AppError) throw err;
    throw new AppError(describeError(err), err.status && err.status < 500 ? err.status : 502, 'action_failed');
  }
  return queryOne('SELECT * FROM assistant_actions WHERE id = ?', row.id);
}

export function dismissAction(row, user) {
  requireWriteAccess(row, user);
  const res = execute("UPDATE assistant_actions SET status = 'dismissed' WHERE id = ? AND status IN ('pending', 'failed')", row.id);
  if (!res.changes) throw new AppError('This action is no longer pending', 409, 'action_stale');
  return queryOne('SELECT * FROM assistant_actions WHERE id = ?', row.id);
}
