import { conflict } from '../lib/errors.js';

let indexed;
async function users(app) {
  const collection = app.mongo.db().collection('users');
  indexed ??= collection.createIndex({ email: 1 }, { unique: true });
  await indexed;
  return collection;
}

export async function createUser(app, { email, passwordHash }) {
  const collection = await users(app);
  try {
    const { insertedId } = await collection.insertOne({ email, passwordHash, role: 'user', createdAt: new Date() });
    return { id: insertedId.toString(), email, role: 'user', passwordHash };
  } catch (err) {
    if (err.code === 11000) throw conflict('An account with this email already exists');
    throw err;
  }
}

export async function findUserByEmail(app, email) {
  const doc = await (await users(app)).findOne({ email });
  return doc ? { id: doc._id.toString(), email: doc.email, role: doc.role, passwordHash: doc.passwordHash } : null;
}
