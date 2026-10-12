import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { capacityReport } from '../engine/capacity.js';

const router = Router();
router.use(requireAuth);

// GET /infrastructure/capacity[?serviceId=...]
router.get('/capacity', (req, res) => {
  const serviceId = typeof req.query.serviceId === 'string' ? req.query.serviceId : null;
  res.json(capacityReport({ serviceId }));
});

export default router;
