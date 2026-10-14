import { hashPassword, verifyPassword } from '../lib/password.js';
import { unauthorized } from '../lib/errors.js';
import { createUser, findUserByEmail } from '../services/users.js';

export const prefix = '/auth';

const credentials = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', format: 'email', maxLength: 254 },
    password: { type: 'string', minLength: 10, maxLength: 200 }
  }
};

// Credential endpoints get a tighter limit than the rest of the API (used when rate limiting is installed).
const strict = { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } };

const session = (app, user) => ({
  token: app.jwt.sign({ sub: user.id, role: user.role }),
  user: { id: user.id, email: user.email, role: user.role }
});

export default async function authRoutes(app) {
  let dummyHash;

  app.post('/register', { schema: { body: credentials }, config: strict }, async (req, reply) => {
    const email = req.body.email.trim().toLowerCase();
    const user = await createUser(app, { email, passwordHash: await hashPassword(req.body.password) });
    return reply.status(201).send(session(app, user));
  });

  app.post('/login', { schema: { body: credentials }, config: strict }, async (req) => {
    const user = await findUserByEmail(app, req.body.email.trim().toLowerCase());
    // Always compare against a hash so the response time does not reveal whether the account exists.
    dummyHash ??= await hashPassword('not-a-real-password');
    const ok = await verifyPassword(req.body.password, user?.passwordHash ?? dummyHash);
    if (!user || !ok) throw unauthorized('Invalid email or password');
    return session(app, user);
  });

  app.get('/me', { onRequest: [app.authenticate] }, async (req) => ({ id: req.user.sub, role: req.user.role }));
}
