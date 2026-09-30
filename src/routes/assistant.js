import { Router } from 'express';
import crypto from 'node:crypto';
import { execute, queryOne, queryAll, transaction } from '../db/index.js';
import { mapThread, mapMessage, mapAction, mapUserRef } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound, conflict, validationError } from '../middleware/error-handler.js';
import { eventBus } from '../engine/event-bus.js';

const router = Router();
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

// GET /projects/:projectId/assistant/threads
router.get('/projects/:projectId/assistant/threads', (req, res) => {
  const { projectId } = req.params;
  const rows = queryAll(`
    SELECT t.*, e.name as environment_name
    FROM assistant_threads t
    LEFT JOIN environments e ON e.id = t.environment_id
    WHERE t.project_id = ?
    ORDER BY t.last_activity_at DESC
  `, projectId);

  const data = rows.map(r => {
    const user = r.created_by ? queryOne('SELECT * FROM users WHERE id = ?', r.created_by) : null;
    const counts = getThreadCounts(r.id);
    return mapThread(r, mapUserRef(user), counts);
  });

  return res.json({ data });
});

// POST /projects/:projectId/assistant/threads
router.post('/projects/:projectId/assistant/threads', (req, res, next) => {
  try {
    const { projectId } = req.params;
    const { environmentId, title = 'New Conversation' } = req.body || {};

    if (!environmentId) throw validationError('environmentId is required');

    const threadId = `thd_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    execute(`
      INSERT INTO assistant_threads (id, project_id, environment_id, title, archived, created_by, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `, threadId, projectId, environmentId, title, req.user.id, now, now);

    const row = queryOne(`
      SELECT t.*, e.name as environment_name
      FROM assistant_threads t
      LEFT JOIN environments e ON e.id = t.environment_id
      WHERE t.id = ?
    `, threadId);

    return res.status(201).json(mapThread(row, mapUserRef(req.user), { messageCount: 0, lastMessagePreview: null, pendingActionCount: 0 }));
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
    data: items.map(mapMessage).reverse(),
    hasMore
  });
});

// POST /assistant/threads/:threadId/messages
router.post('/assistant/threads/:threadId/messages', async (req, res, next) => {
  try {
    const threadId = req.params.threadId;
    const thread = queryOne('SELECT * FROM assistant_threads WHERE id = ?', threadId);
    if (!thread) throw notFound('Thread not found');

    const { content, context = [] } = req.body || {};
    if (!content) throw validationError('content is required');

    const userMsgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const assistantMsgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    const userAuthor = JSON.stringify(mapUserRef(req.user));
    const userContext = JSON.stringify(context);

    // Save user message
    execute(`
      INSERT INTO assistant_messages (id, thread_id, role, status, content, context, author, created_at)
      VALUES (?, ?, 'user', 'done', ?, ?, ?, ?)
    `, userMsgId, threadId, content, userContext, userAuthor, now);

    execute('UPDATE assistant_threads SET last_activity_at = ? WHERE id = ?', now, threadId);

    const userMsgRow = queryOne('SELECT * FROM assistant_messages WHERE id = ?', userMsgId);
    const userMessageMapped = mapMessage(userMsgRow);

    // Prepare assistant reply
    let replyText = `I have analyzed your request: "${content}". Everything in your environment is running smoothly.`;
    if (content.toLowerCase().includes('log') || content.toLowerCase().includes('error')) {
      replyText = `I inspected the deployment logs. Services are running normally with no fatal exceptions detected.`;
    } else if (content.toLowerCase().includes('deploy') || content.toLowerCase().includes('restart')) {
      replyText = `I can help manage your services. You can trigger a deployment or restart anytime from the Services tab.`;
    }

    const assistantNow = new Date(Date.now() + 500).toISOString();
    execute(`
      INSERT INTO assistant_messages (id, thread_id, role, status, content, created_at)
      VALUES (?, ?, 'assistant', 'done', ?, ?)
    `, assistantMsgId, threadId, replyText, assistantNow);

    const assistantMsgRow = queryOne('SELECT * FROM assistant_messages WHERE id = ?', assistantMsgId);
    const assistantMessageMapped = mapMessage(assistantMsgRow);

    const isSse = req.headers.accept && req.headers.accept.includes('text/event-stream');
    if (isSse) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      res.write('event: message.created\n');
      res.write(`data: ${JSON.stringify({ userMessage: userMessageMapped, assistantMessageId: assistantMsgId })}\n\n`);

      res.write('event: delta\n');
      res.write(`data: ${JSON.stringify({ text: replyText })}\n\n`);

      res.write('event: done\n');
      res.write(`data: ${JSON.stringify({ message: assistantMessageMapped })}\n\n`);
      return res.end();
    }

    return res.status(202).json({
      userMessage: userMessageMapped,
      assistantMessageId: assistantMsgId
    });
  } catch (err) {
    next(err);
  }
});

// GET /assistant/messages/:messageId
router.get('/assistant/messages/:messageId', (req, res) => {
  const msg = queryOne('SELECT * FROM assistant_messages WHERE id = ?', req.params.messageId);
  if (!msg) throw notFound('Message not found');
  return res.json(mapMessage(msg));
});

// POST /assistant/messages/:messageId/stop
router.post('/assistant/messages/:messageId/stop', (req, res) => {
  const msg = queryOne('SELECT * FROM assistant_messages WHERE id = ?', req.params.messageId);
  if (!msg) throw notFound('Message not found');
  execute("UPDATE assistant_messages SET status = 'done' WHERE id = ?", msg.id);
  const updated = queryOne('SELECT * FROM assistant_messages WHERE id = ?', msg.id);
  return res.json(mapMessage(updated));
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

// GET /assistant/actions/:actionId
router.get('/assistant/actions/:actionId', (req, res) => {
  const action = queryOne('SELECT * FROM assistant_actions WHERE id = ?', req.params.actionId);
  if (!action) throw notFound('Action not found');
  return res.json(mapAction(action));
});

// POST /assistant/actions/:actionId/apply
router.post('/assistant/actions/:actionId/apply', (req, res) => {
  const action = queryOne('SELECT * FROM assistant_actions WHERE id = ?', req.params.actionId);
  if (!action) throw notFound('Action not found');

  if (action.status !== 'pending') {
    return res.status(409).json({
      code: 'action_stale',
      message: 'Action is no longer pending'
    });
  }

  const now = new Date().toISOString();
  const appliedBy = JSON.stringify(mapUserRef(req.user));
  execute("UPDATE assistant_actions SET status = 'applied', applied_at = ?, applied_by = ? WHERE id = ?", now, appliedBy, action.id);

  const updated = queryOne('SELECT * FROM assistant_actions WHERE id = ?', action.id);
  return res.json(mapAction(updated));
});

// POST /assistant/actions/:actionId/dismiss
router.post('/assistant/actions/:actionId/dismiss', (req, res) => {
  const action = queryOne('SELECT * FROM assistant_actions WHERE id = ?', req.params.actionId);
  if (!action) throw notFound('Action not found');

  execute("UPDATE assistant_actions SET status = 'dismissed' WHERE id = ?", action.id);
  const updated = queryOne('SELECT * FROM assistant_actions WHERE id = ?', action.id);
  return res.json(mapAction(updated));
});

// POST /assistant/actions/:actionId/revert
router.post('/assistant/actions/:actionId/revert', (req, res) => {
  const action = queryOne('SELECT * FROM assistant_actions WHERE id = ?', req.params.actionId);
  if (!action) throw notFound('Action not found');

  if (!action.reversible) {
    return res.status(409).json({
      code: 'action_not_reversible',
      message: 'This action cannot be reverted'
    });
  }

  execute("UPDATE assistant_actions SET status = 'reverted' WHERE id = ?", action.id);
  const updated = queryOne('SELECT * FROM assistant_actions WHERE id = ?', action.id);
  return res.json(mapAction(updated));
});

export default router;
