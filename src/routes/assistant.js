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
import { createAction, publicAction, applyAction, revertAction, dismissAction } from '../services/assistant-actions.js';

const router = Router();

/** A message as the API returns it, with the actions proposed in it. */
function mapMessageFull(row) {
  const m = mapMessage(row);
  if (!m) return m;
  m.actions = queryAll('SELECT * FROM assistant_actions WHERE message_id = ? ORDER BY created_at ASC', row.id).map(publicAction);
  return m;
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
function queryThreads(whereClause, params) {
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
    const msgs = queryAll('SELECT * FROM assistant_messages WHERE thread_id = ? ORDER BY created_at ASC', r.id);
    mapped.messages = msgs.map(mapMessageFull);
    return mapped;
  });
}

// GET /assistant/threads (Global, user-scoped, or project/environment scoped)
router.get('/assistant/threads', (req, res) => {
  const { projectId, environmentId } = req.query;
  const conditions = ['(t.created_by = ? OR t.created_by IS NULL)'];
  const params = [req.user.id];

  if (projectId) {
    conditions.push('t.project_id = ?');
    params.push(projectId);
  }
  if (environmentId) {
    conditions.push('t.environment_id = ?');
    params.push(environmentId);
  }

  const data = queryThreads(conditions.join(' AND '), params);
  return res.json({ data });
});

// POST /assistant/threads (Direct creation with optional projectId / environmentId)
router.post('/assistant/threads', (req, res, next) => {
  try {
    let { id, projectId, environmentId, title = 'New Conversation' } = req.body || {};
    const existingThread = id ? queryOne('SELECT created_by FROM assistant_threads WHERE id = ?', id) : null;
    if (existingThread?.created_by && existingThread.created_by !== req.user.id) throw forbidden('This conversation belongs to someone else');
    const threadId = id || `thd_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

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
  const data = queryThreads('t.project_id = ?', [projectId]);
  return res.json({ data });
});

// POST /projects/:projectId/assistant/threads
router.post('/projects/:projectId/assistant/threads', (req, res, next) => {
  try {
    const { projectId } = req.params;
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
});

// PATCH /assistant/threads/:threadId
router.patch('/assistant/threads/:threadId', (req, res, next) => {
  try {
    const threadId = req.params.threadId;
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
  execute('DELETE FROM assistant_threads WHERE id = ?', threadId);
  return res.status(204).end();
});

// GET /assistant/threads/:threadId/messages
router.get('/assistant/threads/:threadId/messages', (req, res) => {
  const threadId = req.params.threadId;
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

You can also build things: if the developer asks for a new app or API, or for a change to the code of a service that deploys from GitHub, you write the code, show them the exact files or diff, and only apply it after they approve. Mention this when it would help; don't claim to have changed anything yourself in a plain answer.

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

function githubConnected(teamId) {
  return Boolean(queryOne('SELECT 1 AS ok FROM github_integration WHERE team_id = ? AND connected = 1', teamId));
}

async function proposeNewApp({ thread, team, userContent, history, progress }) {
  const environmentId = thread.environment_id
    || queryOne('SELECT id FROM environments WHERE project_id = ? ORDER BY created_at ASC LIMIT 1', thread.project_id)?.id;
  if (!environmentId) return { text: 'This project has no environment to deploy into yet. Create one first.' };
  if (!githubConnected(team.team_id)) {
    return { text: 'Connect GitHub first (Settings, Integrations). I commit the generated code to a new private repository in your account, and Morline deploys from there.' };
  }

  progress('Designing the application');
  const app = await generateNewApp({ prompt: userContent, history, onStep: progress });
  const diff = describeChanges(app.files.map((f) => ({ path: f.path, action: 'create', before: '', after: f.content })));
  const extra = app.envVars.filter((v) => !v.generate);
  const text = [
    `I wrote **${app.name}**${app.description ? `: ${app.description}` : '.'}`,
    app.notes,
    `Applying this creates a private GitHub repository with ${app.files.length} files${app.volume ? `, attaches a ${app.volume.sizeGb} GB volume at \`${app.volume.mountPath}\`` : ''} and deploys it as a new service.`
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

async function proposeCodeChange({ thread, team, route, userContent, history, progress }) {
  const services = projectServices(thread.project_id);
  const service = services.find((s) => s.id === route.serviceId);
  if (!service) {
    const options = services.filter((s) => s.source_type === 'github' && s.source_repo).map((s) => s.name);
    return { text: options.length ? `Which service should I change? It needs to deploy from GitHub: ${options.join(', ')}.` : 'I can only change code for services that deploy from a GitHub repository, and this project has none yet.' };
  }
  if (service.source_type !== 'github' || !service.source_repo) {
    return { text: `**${service.name}** doesn't deploy from a GitHub repository, so there is no source code I can edit. I can still build a new app for you, or help configure it.` };
  }
  if (!githubConnected(team.team_id)) {
    return { text: 'Connect GitHub first (Settings, Integrations) so I can read and write this repository.' };
  }

  const repo = service.source_repo;
  progress(`Reading ${repo}`);
  const settings = queryOne('SELECT branch FROM service_settings WHERE service_id = ?', service.id);
  const { branch, baseSha, tree, readFile } = await withGithub(team.team_id, repo, async (t) => {
    const branch = settings?.branch || service.source_branch || (await getRepo(t, repo)).default_branch;
    const baseSha = await getBranchHead(t, repo, branch);
    const tree = await listFiles(t, repo, baseSha);
    return { branch, baseSha, tree, readFile: (entry) => getBlobText(t, repo, entry.sha) };
  });

  const out = await generateChange({ prompt: userContent, repo, tree, readFile, history, onStep: progress });
  if (!out.changes.length) return { text: out.summary || 'I could not find a change to make for that. Tell me more about what you want.' };

  const message = firstSentence(out.summary) || 'Update from the Morline assistant';
  return {
    text: `${out.summary}\n\nReview the diff below. Applying it commits to \`${branch}\` of \`${repo}\` and redeploys **${service.name}**, or you can open a pull request instead.`,
    actions: [{
      type: 'modify_code',
      title: message,
      description: `${out.changes.length} file${out.changes.length === 1 ? '' : 's'} in ${repo}`,
      risk: 'medium',
      reversible: true,
      targets: [{ type: 'service', id: service.id, label: service.name }],
      payload: { serviceId: service.id, repo, branch, baseSha, mode: 'commit', message, summary: out.summary, changes: out.changes },
      diff: describeChanges(out.changes)
    }]
  };
}

async function respond({ thread, user, userContent, context, history, progress }) {
  if (!llmConfigured()) return { text: await answerQuestion(thread, userContent, history) };

  const team = queryOne('SELECT team_id FROM projects WHERE id = ?', thread.project_id);
  const services = projectServices(thread.project_id);
  const preferred = (Array.isArray(context) ? context : []).find((c) => c?.type === 'service')?.id || null;

  let route = { intent: 'answer', serviceId: preferred };
  try {
    route = await classifyIntent({ message: userContent, services, history, preferredServiceId: preferred });
  } catch (err) {
    console.error('[Assistant] intent routing failed:', err.message);
  }

  try {
    if (team && route.intent === 'build_app') return await proposeNewApp({ thread, team, userContent, history, progress });
    if (team && route.intent === 'change_code') return await proposeCodeChange({ thread, team, route, userContent, history, progress });
  } catch (err) {
    console.error('[Assistant] build failed:', err.message);
    return { text: `I couldn't put that together: ${err.message.replace(/\.$/, '')}.\n\nTry rephrasing, or break the request into smaller steps.` };
  }
  progress('Thinking');
  return { text: await answerQuestion(thread, userContent, history) };
}

// POST /assistant/threads/:threadId/messages
router.post('/assistant/threads/:threadId/messages', async (req, res, next) => {
  try {
    const threadId = req.params.threadId;
    const now = new Date().toISOString();
    let thread = queryOne('SELECT * FROM assistant_threads WHERE id = ?', threadId);

    const userContent = req.body?.content || req.body?.text || req.body?.message;
    if (!userContent) throw validationError('content or text is required');

    // Auto-create thread if client provided a random ID
    if (!thread) {
      const defaultProj = queryOne(`
        SELECT p.id, e.id as env_id
        FROM projects p
        LEFT JOIN environments e ON e.project_id = p.id
        WHERE p.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
        ORDER BY p.created_at ASC LIMIT 1
      `, req.user.id);

      const title = userContent.slice(0, 40) || 'New Conversation';
      execute(`
        INSERT INTO assistant_threads (id, project_id, environment_id, title, archived, created_by, created_at, last_activity_at)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?)
      `, threadId, defaultProj?.id || null, defaultProj?.env_id || null, title, req.user.id, now, now);
      thread = queryOne('SELECT * FROM assistant_threads WHERE id = ?', threadId);
    } else if (thread.created_by && thread.created_by !== req.user.id) {
      throw forbidden('This conversation belongs to someone else');
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

    let outcome;
    try {
      outcome = await respond({ thread, user: req.user, userContent, context, history, progress: (text) => send('status', { text }) });
    } catch (err) {
      console.error('[Assistant]', err);
      outcome = { text: 'Something went wrong while preparing that reply. Try again.' };
    }

    const replyText = outcome.text;
    execute(`
      INSERT INTO assistant_messages (id, thread_id, role, status, content, created_at)
      VALUES (?, ?, 'assistant', 'done', ?, ?)
    `, assistantMsgId, threadId, replyText, new Date(Date.now() + 500).toISOString());
    for (const spec of outcome.actions || []) createAction({ messageId: assistantMsgId, threadId, ...spec });
    const assistantMessageMapped = mapMessageFull(queryOne('SELECT * FROM assistant_messages WHERE id = ?', assistantMsgId));

    if (isSse) {
      send('delta', { text: replyText });
      send('done', { message: assistantMessageMapped, text: replyText });
      return res.end();
    }

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
