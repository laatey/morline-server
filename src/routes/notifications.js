import { Router } from 'express';
import { execute, queryOne, queryAll } from '../db/index.js';
import { mapNotification } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { eventBus } from '../engine/event-bus.js';

const router = Router();
router.use(requireAuth);

// GET /notifications
router.get('/', (req, res) => {
  const rows = queryAll('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', req.user.id);
  const unreadCount = queryOne('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0', req.user.id)?.c || 0;

  return res.json({
    data: rows.map(mapNotification),
    unreadCount
  });
});

// POST /notifications/read
router.post('/read', (req, res) => {
  const { ids } = req.body || {};
  if (Array.isArray(ids) && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    execute(`UPDATE notifications SET read = 1 WHERE user_id = ? AND id IN (${placeholders})`, req.user.id, ...ids);
  } else {
    // Mark all as read
    execute('UPDATE notifications SET read = 1 WHERE user_id = ?', req.user.id);
  }

  const unreadCount = queryOne('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0', req.user.id)?.c || 0;
  return res.json({ success: true, unreadCount });
});

// GET /notifications/stream (SSE)
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  const onNotification = (notif) => {
    res.write('event: notification\n');
    res.write(`data: ${JSON.stringify(notif)}\n\n`);
  };

  eventBus.on(`user:${req.user.id}:notification`, onNotification);

  req.on('close', () => {
    clearInterval(heartbeat);
    eventBus.off(`user:${req.user.id}:notification`, onNotification);
  });
});

export default router;
