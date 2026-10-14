import { Router } from 'express';
import crypto from 'node:crypto';
import { execute, queryOne, queryAll, transaction } from '../db/index.js';
import { mapThread, mapMessage, mapAction, mapUserRef } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound, conflict, validationError, forbidden } from '../middleware/error-handler.js';
import { logManager } from '../engine/log-manager.js';
import { complete, llmConfigured } from '../services/llm.js';
import { classifyIntent, generateNewApp, generateChange } from '../services/builder/generate.js';
import { describeChanges } from '../services/builder/diff.js';
import { GitHubError, withGithub, getRepo, getBranchHead, listFiles, getBlobText } from '../services/github-repo.js';
import { listWorkspaceFiles, readWorkspaceFile } from '../services/service-factory.js';
import { collectLogs } from '../engine/diagnosis-manager.js';
import { createAction, publicAction, applyAction, revertAction, dismissAction, githubConnected } from '../services/assistant-actions.js';

const router = Router();

/** A message as the API returns it, with the actions proposed in it. */
function mapMessageFull(row) {
  const m = mapMessage(row);
  if (!m) return m;
  m.actions = queryAll('SELECT * FROM assistant_actions WHERE message_id = ? ORDER BY created_at ASC', row.id).map(publicAction);
  return m;
}
/** Is this user on the team that owns the project? Conversations never cross project lines. */
function isProjectMember(user, projectId) {
  if (!projectId) return false;
  return Boolean(queryOne(`
    SELECT 1 AS ok FROM projects p
    JOIN team_members m ON m.team_id = p.team_id
    WHERE p.id = ? AND m.user_id = ?
  `, projectId, user.id));
}

/** Load a thread the user may see: it must belong to a project they are a member of. */
function loadThreadFor(user, threadId) {
  const thread = queryOne('SELECT * FROM assistant_threads WHERE id = ?', threadId);
  if (!thread) throw notFound('Thread not found');
  if (!isProjectMember(user, thread.project_id) && thread.created_by !== user.id) throw forbidden('This conversation belongs to another project');
  return thread;
}

router.use('/projects/:projectId/assistant', requireAuth);
router.use('/assistant', requireAuth);

function getThreadCounts(threadId) {
  const msgCount = queryOne('SELECT COUNT(*) as c FROM assistant_messages WHERE thread_id = ?', threadId)?.c || 0;
  const lastMsg = queryOne('SELECT content FROM assistant_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', threadId)?.content || null;
  const pendingActions = queryOne("SELECT COUNT(*) as c FROM assistant_actions WHERE thread_id = ? AND status = 'pending'", threadId)?.c || 0;

  return {
    messageCount: msgCount,
    lastMessagePreview: lastMsg ? (lastMsg.length > 80 ? lastMsg.slice(0, 80) + '...' : lastMsg) : null,
    pendingActionCount: pendingActions
  };
}

// GET /projects/:projectId/assistant/suggestions
router.get('/projects/:projectId/assistant/suggestions', (req, res) => {
  const { projectId } = req.params;
  const { environmentId, serviceId } = req.query;

  const services = queryAll('SELECT id, name, status FROM services WHERE environment_id = ?', environmentId || '');
  const crashed = services.filter(s => s.status === 'crashed');

  const suggestions = [];

  if (crashed.length > 0) {
    suggestions.push({
      text: `Why is service "${crashed[0].name}" crashing and how do I fix it?`,
      context: [{ type: 'service', id: crashed[0].id, label: crashed[0].name }]
    });
  }

  suggestions.push(
    {
      text: 'Build a REST API with login and a SQLite database, and deploy it',
      context: []
    },
    {
      text: 'How can I connect my frontend and backend services?',
      context: []
    },
    {
      text: 'Recommend environment variables for production security',
      context: []
    },
    {
      text: 'Show me deployment logs and recent errors',
      context: []
    }
  );

  return res.json({ data: suggestions });
});

// Helper to get threads for a query
function queryThreads(whereClause, params, { messageLimit = 30 } = {}) {
  const rows = queryAll(`
    SELECT t.*, e.name as environment_name
    FROM assistant_threads t
    LEFT JOIN environments e ON e.id = t.environment_id
    WHERE ${whereClause}
    ORDER BY t.last_activity_at DESC
  `, ...params);

  return rows.map(r => {
    const user = r.created_by ? queryOne('SELECT * FROM users WHERE id = ?', r.created_by) : null;
    const counts = getThreadCounts(r.id);
    const mapped = mapThread(r, mapUserRef(user), counts);
    // Include messages array for frontend direct consumption
    // Newest messages only; older ones are fetched as the user scrolls back up.
    const msgs = queryAll('SELECT * FROM assistant_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?', r.id, messageLimit).reverse();
    mapped.messages = msgs.map(mapMessageFull);
    mapped.hasMoreMessages = counts.messageCount > msgs.length;
    return mapped;
  });
}

// GET /assistant/threads?projectId=...  Conversations are per project, so a project is required.
router.get('/assistant/threads', (req, res) => {
  const { projectId, environmentId } = req.query;
  if (!projectId || !isProjectMember(req.user, projectId)) return res.json({ data: [] });
  const conditions = ['t.project_id = ?'];
  const params = [projectId];
  if (environmentId) {
    conditions.push('t.environment_id = ?');
    params.push(environmentId);
  }
  return res.json({ data: queryThreads(conditions.join(' AND '), params) });
});

// POST /assistant/threads (Direct creation with optional projectId / environmentId)
router.post('/assistant/threads', (req, res, next) => {
  try {
    let { id, projectId, environmentId, title = 'New Conversation' } = req.body || {};
    const existingThread = id ? queryOne('SELECT created_by FROM assistant_threads WHERE id = ?', id) : null;
    if (existingThread?.created_by && existingThread.created_by !== req.user.id) throw forbidden('This conversation belongs to someone else');
    const threadId = id || `thd_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    if (projectId && !isProjectMember(req.user, projectId)) throw forbidden('You are not a member of this project');
    // Auto-resolve project/environment if not provided
    if (!projectId) {
      const defaultProj = queryOne(`
        SELECT p.id, e.id as env_id 
        FROM projects p 
        LEFT JOIN environments e ON e.project_id = p.id 
        WHERE p.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
        ORDER BY p.created_at ASC LIMIT 1
      `, req.user.id);
      projectId = defaultProj?.id || null;
      if (!environmentId) environmentId = defaultProj?.env_id || null;
    }

    execute(`
      INSERT INTO assistant_threads (id, project_id, environment_id, title, archived, created_by, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, last_activity_at = excluded.last_activity_at
    `, threadId, projectId, environmentId, title, req.user.id, now, now);

    const row = queryOne(`
      SELECT t.*, e.name as environment_name
      FROM assistant_threads t
      LEFT JOIN environments e ON e.id = t.environment_id
      WHERE t.id = ?
    `, threadId);

    const mapped = mapThread(row, mapUserRef(req.user), { messageCount: 0, lastMessagePreview: null, pendingActionCount: 0 });
    mapped.messages = [];
    return res.status(201).json(mapped);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/assistant/threads
router.get('/projects/:projectId/assistant/threads', (req, res) => {
  const { projectId } = req.params;
  if (!isProjectMember(req.user, projectId)) return res.json({ data: [] });
  const data = queryThreads('t.project_id = ?', [projectId]);
  return res.json({ data });
});

// POST /projects/:projectId/assistant/threads
router.post('/projects/:projectId/assistant/threads', (req, res, next) => {
  try {
    const { projectId } = req.params;
    if (!isProjectMember(req.user, projectId)) throw forbidden('You are not a member of this project');
    let { id, environmentId, title = 'New Conversation' } = req.body || {};
    const existingThread = id ? queryOne('SELECT created_by FROM assistant_threads WHERE id = ?', id) : null;
    if (existingThread?.created_by && existingThread.created_by !== req.user.id) throw forbidden('This conversation belongs to someone else');

    if (!environmentId) {
      const envRow = queryOne('SELECT id FROM environments WHERE project_id = ? ORDER BY created_at ASC LIMIT 1', projectId);
      environmentId = envRow?.id || null;
    }

    const threadId = id || `thd_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    execute(`
      INSERT INTO assistant_threads (id, project_id, environment_id, title, archived, created_by, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, last_activity_at = excluded.last_activity_at
    `, threadId, projectId, environmentId, title, req.user.id, now, now);

    const row = queryOne(`
      SELECT t.*, e.name as environment_name
      FROM assistant_threads t
      LEFT JOIN environments e ON e.id = t.environment_id
      WHERE t.id = ?
    `, threadId);

    const mapped = mapThread(row, mapUserRef(req.user), { messageCount: 0, lastMessagePreview: null, pendingActionCount: 0 });
    mapped.messages = [];
    return res.status(201).json(mapped);
  } catch (err) {
    next(err);
  }
});

// GET /assistant/threads/:threadId
router.get('/assistant/threads/:threadId', (req, res) => {
  const threadId = req.params.threadId;
  loadThreadFor(req.user, threadId);
  const row = queryOne(`
    SELECT t.*, e.name as environment_name
    FROM assistant_threads t
    LEFT JOIN environments e ON e.id = t.environment_id
    WHERE t.id = ?
  `, threadId);

  const user = row.created_by ? queryOne('SELECT * FROM users WHERE id = ?', row.created_by) : null;
  const counts = getThreadCounts(row.id);
  return res.json(mapThread(row, mapUserRef(user), counts));
});

// PATCH /assistant/threads/:threadId
router.patch('/assistant/threads/:threadId', (req, res, next) => {
  try {
    const threadId = req.params.threadId;
    loadThreadFor(req.user, threadId);
    const { title, archived } = req.body || {};

    const updates = [];
    const params = [];

    if (title !== undefined) {
      updates.push('title = ?');
      params.push(title);
    }
    if (archived !== undefined) {
      updates.push('archived = ?');
      params.push(archived ? 1 : 0);
    }

    if (updates.length > 0) {
      params.push(threadId);
      execute(`UPDATE assistant_threads SET ${updates.join(', ')} WHERE id = ?`, ...params);
    }

    const row = queryOne(`
      SELECT t.*, e.name as environment_name
      FROM assistant_threads t
      LEFT JOIN environments e ON e.id = t.environment_id
      WHERE t.id = ?
    `, threadId);
    if (!row) throw notFound('Thread not found');

    const user = row.created_by ? queryOne('SELECT * FROM users WHERE id = ?', row.created_by) : null;
    const counts = getThreadCounts(row.id);
    return res.json(mapThread(row, mapUserRef(user), counts));
  } catch (err) {
    next(err);
  }
});

// DELETE /assistant/threads/:threadId
router.delete('/assistant/threads/:threadId', (req, res) => {
  const threadId = req.params.threadId;
  const existing = queryOne('SELECT id FROM assistant_threads WHERE id = ?', threadId);
  if (existing) loadThreadFor(req.user, threadId);
  execute('DELETE FROM assistant_threads WHERE id = ?', threadId);
  return res.status(204).end();
});

// GET /assistant/threads/:threadId/messages
router.get('/assistant/threads/:threadId/messages', (req, res) => {
  const threadId = req.params.threadId;
  loadThreadFor(req.user, threadId);
  const limit = parseInt(req.query.limit || '50', 10);
  const before = req.query.before;

  let sql = 'SELECT * FROM assistant_messages WHERE thread_id = ?';
  const params = [threadId];

  if (before) {
    const beforeRow = queryOne('SELECT created_at FROM assistant_messages WHERE id = ?', before);
    if (beforeRow) {
      sql += ' AND created_at < ?';
      params.push(beforeRow.created_at);
    }
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit + 1);

  const rows = queryAll(sql, ...params);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return res.json({
    data: items.map(mapMessageFull).reverse(),
    hasMore
  });
});

// --- Replies ---------------------------------------------------------------------------------

function projectServices(projectId) {
  return queryAll(`
    SELECT s.id, s.name, s.kind, s.status, s.port, s.primary_domain, s.source_type, s.source_repo, s.source_branch, s.environment_id
    FROM services s
    JOIN environments e ON e.id = s.environment_id
    WHERE e.project_id = ?
  `, projectId);
}

async function answerQuestion(thread, userContent, history) {
  const services = projectServices(thread.project_id);
  const crashedServices = services.filter((s) => s.status === 'crashed');
  const recentErrors = queryAll(`
    SELECT d.service_name, d.error_summary, d.finished_at
    FROM deployments d
    JOIN services s ON s.id = d.service_id
    JOIN environments e ON e.id = s.environment_id
    WHERE e.project_id = ? AND d.state = 'failed'
    ORDER BY d.created_at DESC LIMIT 3
  `, thread.project_id);

  let crashedLogs = '';
  for (const s of crashedServices) {
    const logs = logManager.getServiceLogs(s.id, { limit: 15 });
    if (logs.length > 0) {
      crashedLogs += `\nLogs for service ${s.name} (CRASHED):\n` + logs.map((l) => `[${l.level}] ${l.message}`).join('\n');
    }
  }

  const system = `You are the Morline assistant, built into the Morline cloud platform. You help developers deploy, debug and configure services, databases, variables and domains.

You can also build things: if the developer asks for a new app or API, or for a change to a service's code, or reports that something broke, you do it: you write the code and Morline shows the exact diff as a card they can apply. Because that card is the confirmation, never ask "would you like me to...", "do you want me to proceed" or "shall I apply this". When they ask for something, do it. Ask a question only when you truly lack information you cannot work out yourself. In a plain answer don't claim to have changed anything.

Current platform context:
- Project ID: ${thread.project_id}
- Services: ${JSON.stringify(services.map((s) => ({ name: s.name, kind: s.kind, status: s.status, domain: s.primary_domain, repo: s.source_repo || null })))}
- Recent deployment failures: ${JSON.stringify(recentErrors)}
${crashedLogs ? `\nRecent crash logs:\n${crashedLogs}` : ''}

Be direct, concise and technically accurate. Explain root causes and give concrete fixes. Use clean markdown with code blocks where they help.`;

  try {
    return await complete({ system, messages: [...history, { role: 'user', content: userContent }], maxTokens: 2000, temperature: 0.3 });
  } catch (err) {
    console.error('[Assistant]', err.message);
    return llmConfigured()
      ? 'I could not reach the AI provider just now. Try again in a moment.'
      : 'The assistant is not configured on this server yet. Set AI_GATEWAY_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY in the server environment.';
  }
}

const firstSentence = (text, max = 72) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] || '';
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

async function proposeNewApp({ thread, team, userContent, history, progress }) {
  const environmentId = thread.environment_id
    || queryOne('SELECT id FROM environments WHERE project_id = ? ORDER BY created_at ASC LIMIT 1', thread.project_id)?.id;
  if (!environmentId) return { text: 'This project has no environment to deploy into yet. Create one first.' };
  progress('Designing the application');
  const app = await generateNewApp({ prompt: userContent, history, onStep: progress });
  const diff = describeChanges(app.files.map((f) => ({ path: f.path, action: 'create', before: '', after: f.content })));
  const extra = app.envVars.filter((v) => !v.generate);
  const text = [
    `I wrote **${app.name}**${app.description ? `: ${app.description}` : '.'}`,
    app.notes,
    `Applying this deploys ${app.files.length} files as a new service${app.volume ? ` with a ${app.volume.sizeGb} GB volume at \`${app.volume.mountPath}\`` : ''}. You can deploy straight away, or also save the code to a new private GitHub repository.`
      + (app.envVars.some((v) => v.generate) ? ` Secrets such as ${app.envVars.filter((v) => v.generate).map((v) => `\`${v.key}\``).join(', ')} are generated for you.` : ''),
    extra.length ? `You will need to set: ${extra.map((v) => `\`${v.key}\`${v.description ? ` (${v.description})` : ''}`).join(', ')}.` : ''
  ].filter(Boolean).join('\n\n');

  return {
    text,
    actions: [{
      type: 'create_app',
      title: `Create ${app.name}`,
      description: app.description,
      risk: 'medium',
      reversible: true,
      targets: [{ type: 'environment', id: environmentId }],
      payload: { name: app.name, description: app.description, port: app.port, envVars: app.envVars, volume: app.volume, files: app.files, environmentId, projectId: thread.project_id },
      diff
    }]
  };
}

async function proposeCodeChange({ thread, team, route, userContent, history, progress, displayPrompt }) {
  const services = projectServices(thread.project_id);
  const service = services.find((s) => s.id === route.serviceId);
  const editable = (s) => (s.source_type === 'github' && s.source_repo) || s.source_type === 'local';
  if (!service) {
    const options = services.filter(editable).map((s) => s.name);
    return { text: options.length ? `Which service should I change? It needs to be an app I generated or one that deploys from GitHub: ${options.join(', ')}.` : 'I can only change code for apps I generated or services that deploy from a GitHub repository, and this project has none yet.' };
  }
  if (!editable(service)) {
    return { text: `**${service.name}** doesn't deploy from a GitHub repository, so there is no source code I can edit. I can still build a new app for you, or help configure it.` };
  }

  // Where the code lives: a GitHub repo, or the service's own build workspace.
  let repo = service.source_repo;
  let branch;
  let baseSha;
  let tree;
  let readFile;
  const local = service.source_type === 'local';
  if (local) {
    repo = null;
    branch = 'local';
    baseSha = 'local';
    progress(`Reading ${service.name}`);
    tree = listWorkspaceFiles(service.id);
    readFile = async (entry) => readWorkspaceFile(service.id, entry.path);
  } else {
    if (!githubConnected(team.team_id)) {
      return { text: 'Connect GitHub first (Settings, Integrations) so I can read and write this repository.' };
    }
    progress(`Reading ${repo}`);
    const settings = queryOne('SELECT branch FROM service_settings WHERE service_id = ?', service.id);
    ({ branch, baseSha, tree, readFile } = await withGithub(team.team_id, repo, async (t) => {
      const branch = settings?.branch || service.source_branch || (await getRepo(t, repo)).default_branch;
      const baseSha = await getBranchHead(t, repo, branch);
      const tree = await listFiles(t, repo, baseSha);
      return { branch, baseSha, tree, readFile: (entry) => getBlobText(t, repo, entry.sha) };
    }));
  }

  const out = await generateChange({ prompt: userContent, repo: repo || service.name, tree, readFile, history, onStep: progress });
  if (!out.changes.length) return { text: out.summary || 'I could not find a change to make for that. Tell me more about what you want.' };

  const message = firstSentence(out.summary) || 'Update from the Morline assistant';
  const where = local ? `\`${service.name}\`` : `\`${branch}\` of \`${repo}\``;
  return {
    text: `${stripPermissionAsks(out.summary)}\n\nReview the diff below. Applying it ${local ? 'updates the files of' : `commits to ${where} and redeploys`}${local ? ` **${service.name}** and redeploys it` : ` **${service.name}**, or you can open a pull request instead`}.`,
    actions: [{
      type: 'modify_code',
      title: message,
      description: `${out.changes.length} file${out.changes.length === 1 ? '' : 's'} in ${repo || service.name}`,
      risk: 'medium',
      reversible: true,
      targets: [{ type: 'service', id: service.id, label: service.name }],
      payload: { serviceId: service.id, repo, branch, baseSha, mode: 'commit', local, message, summary: out.summary, changes: out.changes },
      diff: describeChanges(out.changes)
    }]
  };
}

/** "Fix and deploy": read the failed deployment's logs and propose a code change that fixes it. */
async function proposeFix({ thread, team, deploymentId, userContent, history, progress }) {
  const dep = queryOne(`
    SELECT d.*, e.project_id FROM deployments d
    JOIN services s ON s.id = d.service_id
    JOIN environments e ON e.id = s.environment_id
    WHERE d.id = ?
  `, deploymentId);
  if (!dep || dep.project_id !== thread.project_id) return { text: 'I could not find that deployment in this project.' };

  progress(`Reading the logs of ${dep.service_name}`);
  const logs = collectLogs(deploymentId);
  const prompt = [
    `The latest deployment of "${dep.service_name}" ${dep.state === 'crashed' ? 'crashed' : 'failed'}. Find the root cause and fix it in the code, the Dockerfile or the configuration files, so the next deploy succeeds.`,
    dep.error_summary ? `Recorded error: ${String(dep.error_summary).slice(0, 800)}` : '',
    `The log below may be missing the underlying error line. If it is, work it out from the files: check the Dockerfile step order (a file must be copied before a command uses it), install lifecycle scripts such as postinstall, devDependencies that are omitted in production, and start commands.`,
    `Deployment logs:\n${logs || '(no logs were captured)'}`,
    userContent && !/^fix (and|&) deploy/i.test(userContent) ? `The user also said: ${userContent}` : ''
  ].filter(Boolean).join('\n\n');

  const out = await proposeCodeChange({ thread, team, route: { serviceId: dep.service_id }, userContent: prompt, history, progress });
  return out;
}

/** Drop trailing "Would you like me to…?" lines: the review card is the confirmation, not the chat. */
function stripPermissionAsks(text) {
  const ask = /^(would you like|do you want|shall i|should i|want me to|would you prefer|can i go ahead|let me know if you(?:'d| would) like|i can (?:apply|do) (?:this|that|it) (?:for you )?if)/i;
  const paragraphs = String(text || '').trim().split(/\n{2,}/);
  while (paragraphs.length > 1 && ask.test(paragraphs[paragraphs.length - 1].trim())) paragraphs.pop();
  const last = paragraphs.length - 1;
  const sentences = paragraphs[last].split(/(?<=[.!?])\s+/);
  while (sentences.length > 1 && ask.test(sentences[sentences.length - 1].trim())) sentences.pop();
  paragraphs[last] = sentences.join(' ');
  return paragraphs.join('\n\n').trim();
}

const CONFIRMS = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|please|please do|go ahead|do it|proceed|apply( it| that)?|sounds good|fix it|yes please|y)\b[\s.!]*$/i;
const REPORTS_BREAKAGE = /\b(crash(ed|es|ing)?|fail(ed|s|ing|ure)?|broke(n)?|not working|doesn'?t work|won'?t (start|build|deploy|run)|errors?|errored)\b/i;
const OFFERED_CHANGE = /\b(apply|fix|change|redeploy|proceed|would you like|do you want)\b/i;

/** The newest failed or crashed deployment that is still a service's latest one. */
function latestBrokenDeployment(projectId, preferredServiceId) {
  const rows = queryAll(`
    SELECT d.id, d.service_id, d.service_name, d.state, d.created_at
    FROM deployments d
    JOIN services s ON s.id = d.service_id
    JOIN environments e ON e.id = s.environment_id
    WHERE e.project_id = ?
      AND d.created_at = (SELECT MAX(d2.created_at) FROM deployments d2 WHERE d2.service_id = d.service_id)
      AND d.state IN ('failed', 'crashed')
    ORDER BY d.created_at DESC
  `, projectId);
  return rows.find((r) => r.service_id === preferredServiceId) || rows[0] || null;
}

async function respond({ thread, user, userContent, context, history, progress }) {
  if (!llmConfigured()) return { text: await answerQuestion(thread, userContent, history) };

  const team = queryOne('SELECT team_id FROM projects WHERE id = ?', thread.project_id);
  const services = projectServices(thread.project_id);
  const ctxList = Array.isArray(context) ? context : (context ? [context] : []);
  const preferred = ctxList.find((c) => c?.type === 'service')?.id || null;
  const failedDeployment = ctxList.find((c) => c?.type === 'deployment' && c.deploymentId);
  const wantsFix = failedDeployment && /\b(fix|repair|resolve|patch)\b/i.test(userContent);
  if (team && wantsFix) {
    try {
      return await proposeFix({ thread, team, deploymentId: failedDeployment.deploymentId, userContent, history, progress });
    } catch (err) {
      console.error('[Assistant] fix failed:', err.message);
      return { text: `I couldn't work out a fix: ${err.message.replace(/\.$/, '')}.` };
    }
  }

  // Someone who reports a broken deploy, or says "yes" to a fix, wants it fixed, not another question.
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant')?.content || '';
  const confirming = CONFIRMS.test(userContent) && OFFERED_CHANGE.test(lastAssistant);
  const reporting = REPORTS_BREAKAGE.test(userContent) && !/^\s*(what|why|how|explain|can you explain)\b/i.test(userContent);
  if (team && (confirming || reporting)) {
    const broken = latestBrokenDeployment(thread.project_id, preferred);
    if (broken) {
      try {
        return await proposeFix({ thread, team, deploymentId: broken.id, userContent, history, progress });
      } catch (err) {
        console.error('[Assistant] fix failed:', err.message);
        return { text: `I couldn't work out a fix: ${err.message.replace(/\.$/, '')}.` };
      }
    }
  }
  // "Yes" to something proposed earlier: carry that out rather than starting a new conversation.
  const message = confirming ? `Carry out what you just proposed:\n${lastAssistant.slice(0, 1500)}` : userContent;

  let route = { intent: 'answer', serviceId: preferred };
  try {
    route = await classifyIntent({ message, services, history, preferredServiceId: preferred });
  } catch (err) {
    console.error('[Assistant] intent routing failed:', err.message);
  }

  try {
    if (team && route.intent === 'build_app') return await proposeNewApp({ thread, team, userContent: message, history, progress });
    if (team && route.intent === 'change_code') return await proposeCodeChange({ thread, team, route, userContent: message, history, progress });
  } catch (err) {
    console.error('[Assistant] build failed:', err.message);
    return { text: `I couldn't put that together: ${err.message.replace(/\.$/, '')}.\n\nTry rephrasing, or break the request into smaller steps.` };
  }
  progress('Thinking');
  return { text: stripPermissionAsks(await answerQuestion(thread, userContent, history)) };
}

/** A 2-5 word name for a conversation. Falls back to the user's own words when no model is available. */
async function generateThreadTitle(userContent, replyText) {
  const fallback = firstSentence(userContent, 40) || 'New conversation';
  if (!llmConfigured()) return fallback;
  try {
    const raw = await complete({
      system: 'You name chat conversations. Reply with only a short title of 2 to 5 words that captures the topic. No quotes, no trailing punctuation, no emoji. Use sentence case.',
      messages: [{ role: 'user', content: `User message:\n${userContent.slice(0, 600)}\n\nAssistant reply:\n${String(replyText || '').slice(0, 400)}\n\nTitle:` }],
      maxTokens: 24,
      temperature: 0.3
    });
    const title = raw.split('\n')[0].replace(/^["'`\s]+|["'`.\s]+$/g, '').slice(0, 60);
    return title || fallback;
  } catch (err) {
    console.error('[Assistant] title generation failed:', err.message);
    return fallback;
  }
}

// POST /assistant/threads/:threadId/messages
router.post('/assistant/threads/:threadId/messages', async (req, res, next) => {
  try {
    const threadId = req.params.threadId;
    const now = new Date().toISOString();
    let thread = queryOne('SELECT * FROM assistant_threads WHERE id = ?', threadId);

    const userContent = req.body?.content || req.body?.text || req.body?.message;
    if (!userContent) throw validationError('content or text is required');

    const bodyProjectId = req.body?.projectId || null;
    // Auto-create thread if client provided a random ID. It belongs to the project the user is in.
    if (!thread) {
      let projectId = bodyProjectId;
      if (projectId && !isProjectMember(req.user, projectId)) throw forbidden('You are not a member of this project');
      if (!projectId) {
        projectId = queryOne(`
          SELECT p.id FROM projects p
          WHERE p.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
          ORDER BY p.created_at ASC LIMIT 1
        `, req.user.id)?.id || null;
      }
      const environmentId = (req.body?.environmentId
        && queryOne('SELECT id FROM environments WHERE id = ? AND project_id = ?', req.body.environmentId, projectId)?.id)
        || queryOne('SELECT id FROM environments WHERE project_id = ? ORDER BY created_at ASC LIMIT 1', projectId)?.id || null;

      const title = userContent.slice(0, 40) || 'New Conversation';
      execute(`
        INSERT INTO assistant_threads (id, project_id, environment_id, title, archived, created_by, created_at, last_activity_at)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?)
      `, threadId, projectId, environmentId, title, req.user.id, now, now);
      thread = queryOne('SELECT * FROM assistant_threads WHERE id = ?', threadId);
    } else {
      if (thread.created_by && thread.created_by !== req.user.id) throw forbidden('This conversation belongs to someone else');
      if (bodyProjectId && thread.project_id !== bodyProjectId) throw forbidden('This conversation belongs to another project');
    }

    const { context = [] } = req.body || {};
    const userMsgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const assistantMsgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

    // Conversation so far, taken before this message is stored so it isn't sent twice.
    const history = queryAll(`
      SELECT role, content FROM assistant_messages
      WHERE thread_id = ? AND role IN ('user', 'assistant') ORDER BY created_at DESC LIMIT 10
    `, threadId).reverse().map((m) => ({ role: m.role, content: m.content }));

    execute(`
      INSERT INTO assistant_messages (id, thread_id, role, status, content, context, author, created_at)
      VALUES (?, ?, 'user', 'done', ?, ?, ?, ?)
    `, userMsgId, threadId, userContent, JSON.stringify(context), JSON.stringify(mapUserRef(req.user)), now);
    execute('UPDATE assistant_threads SET last_activity_at = ? WHERE id = ?', now, threadId);
    const userMessageMapped = mapMessage(queryOne('SELECT * FROM assistant_messages WHERE id = ?', userMsgId));

    const isSse = Boolean(req.headers.accept && req.headers.accept.includes('text/event-stream'));
    const send = (event, data) => { if (isSse) { res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); } };
    if (isSse) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      send('message.created', { userMessage: userMessageMapped, assistantMessageId: assistantMsgId });
    }

    const startedAt = Date.now();
    const steps = [];
    const isFirstMessage = history.length === 0;
    let outcome;
    try {
      outcome = await respond({
        thread, user: req.user, userContent, context, history,
        progress: (text) => { if (text && steps[steps.length - 1] !== text) steps.push(text); send('status', { text }); }
      });
    } catch (err) {
      console.error('[Assistant]', err);
      outcome = { text: 'Something went wrong while preparing that reply. Try again.' };
    }

    const replyText = outcome.text;
    // Keep the work behind the reply so "Worked for 8s" survives a refresh.
    const toolCalls = steps.length ? JSON.stringify({ steps, durationMs: Date.now() - startedAt }) : null;
    execute(`
      INSERT INTO assistant_messages (id, thread_id, role, status, content, tool_calls, created_at)
      VALUES (?, ?, 'assistant', 'done', ?, ?, ?)
    `, assistantMsgId, threadId, replyText, toolCalls, new Date(Date.now() + 500).toISOString());
    for (const spec of outcome.actions || []) createAction({ messageId: assistantMsgId, threadId, ...spec });
    const assistantMessageMapped = mapMessageFull(queryOne('SELECT * FROM assistant_messages WHERE id = ?', assistantMsgId));

    // First message of a conversation: have the model name it.
    const titleFor = async () => {
      if (!isFirstMessage) return null;
      const title = await generateThreadTitle(userContent, replyText);
      execute('UPDATE assistant_threads SET title = ? WHERE id = ?', title, threadId);
      return title;
    };

    if (isSse) {
      send('delta', { text: replyText });
      send('done', { message: assistantMessageMapped, text: replyText });
      const title = await titleFor().catch(() => null);
      if (title) send('thread.title', { threadId, title });
      return res.end();
    }
    await titleFor().catch(() => null);

    const allMsgs = queryAll('SELECT * FROM assistant_messages WHERE thread_id = ? ORDER BY created_at ASC', threadId);
    const updatedThread = queryOne('SELECT * FROM assistant_threads WHERE id = ?', threadId);
    const legacy = allMsgs.map((m) => ({ role: m.role === 'assistant' ? 'agent' : m.role, text: m.content }));
    return res.status(200).json({
      thread: { id: threadId, title: updatedThread?.title || 'New conversation', messages: legacy },
      messages: legacy,
      reply: { role: 'agent', text: replyText },
      message: { role: 'agent', text: replyText },
      text: replyText,
      userMessage: userMessageMapped,
      assistantMessage: assistantMessageMapped,
      assistantMessageId: assistantMsgId
    });
  } catch (err) {
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      return res.end();
    }
    next(err);
  }
});

// GET /assistant/messages/:messageId
router.get('/assistant/messages/:messageId', (req, res) => {
  const msg = queryOne('SELECT * FROM assistant_messages WHERE id = ?', req.params.messageId);
  if (!msg) throw notFound('Message not found');
  return res.json(mapMessageFull(msg));
});

// POST /assistant/messages/:messageId/stop
router.post('/assistant/messages/:messageId/stop', (req, res) => {
  const msg = queryOne('SELECT * FROM assistant_messages WHERE id = ?', req.params.messageId);
  if (!msg) throw notFound('Message not found');
  execute("UPDATE assistant_messages SET status = 'done' WHERE id = ?", msg.id);
  const updated = queryOne('SELECT * FROM assistant_messages WHERE id = ?', msg.id);
  return res.json(mapMessageFull(updated));
});

// POST /assistant/messages/:messageId/regenerate
router.post('/assistant/messages/:messageId/regenerate', (req, res) => {
  const msg = queryOne('SELECT * FROM assistant_messages WHERE id = ?', req.params.messageId);
  if (!msg) throw notFound('Message not found');
  return res.status(202).json({
    userMessage: mapMessage(msg),
    assistantMessageId: msg.id
  });
});

// PUT /assistant/messages/:messageId/feedback
router.put('/assistant/messages/:messageId/feedback', (req, res) => {
  const msg = queryOne('SELECT * FROM assistant_messages WHERE id = ?', req.params.messageId);
  if (!msg) throw notFound('Message not found');

  const { feedback } = req.body || {};
  execute('UPDATE assistant_messages SET feedback = ? WHERE id = ?', feedback, msg.id);
  return res.status(204).end();
});

// --- Actions -----------------------------------------------------------------------------------

function loadAction(id) {
  const action = queryOne('SELECT * FROM assistant_actions WHERE id = ?', id);
  if (!action) throw notFound('Action not found');
  return action;
}

// GET /assistant/actions/:actionId
router.get('/assistant/actions/:actionId', (req, res) => {
  return res.json(publicAction(loadAction(req.params.actionId)));
});

// POST /assistant/actions/:actionId/apply   body: { mode?: 'commit' | 'pr' }
router.post('/assistant/actions/:actionId/apply', async (req, res, next) => {
  try {
    const action = loadAction(req.params.actionId);
    const mode = req.body?.mode;
    if (action.type === 'modify_code' && (mode === 'commit' || mode === 'pr') && action.status === 'pending') {
      const payload = JSON.parse(action.payload || '{}');
      payload.mode = mode;
      execute('UPDATE assistant_actions SET payload = ? WHERE id = ?', JSON.stringify(payload), action.id);
    }
    const deploy = req.body?.deploy;
    if (action.type === 'create_app' && (deploy === 'github' || deploy === 'direct') && action.status !== 'applying') {
      const payload = JSON.parse(action.payload || '{}');
      payload.deploy = deploy;
      execute('UPDATE assistant_actions SET payload = ? WHERE id = ?', JSON.stringify(payload), action.id);
    }
    const updated = await applyAction(loadAction(action.id), req.user);
    return res.json(publicAction(updated));
  } catch (err) {
    next(err);
  }
});

// POST /assistant/actions/:actionId/dismiss
router.post('/assistant/actions/:actionId/dismiss', (req, res, next) => {
  try {
    return res.json(publicAction(dismissAction(loadAction(req.params.actionId), req.user)));
  } catch (err) {
    next(err);
  }
});

// POST /assistant/actions/:actionId/revert
router.post('/assistant/actions/:actionId/revert', async (req, res, next) => {
  try {
    const updated = await revertAction(loadAction(req.params.actionId), req.user);
    return res.json(publicAction(updated));
  } catch (err) {
    next(err);
  }
});

export default router;
