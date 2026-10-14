import { conflict } from '../lib/errors.js';

const present = (row) => (row ? { id: row.id, email: row.email, role: row.role, passwordHash: row.password_hash } : null);

export async function createUser(app, { email, passwordHash }) {
  try {
    const { rows } = await app.pg.query(
      'insert into users (email, password_hash) values ($1, $2) returning id, email, role, password_hash',
      [email, passwordHash]
    );
    return present(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw conflict('An account with this email already exists');
    throw err;
  }
}

export async function findUserByEmail(app, email) {
  const { rows } = await app.pg.query('select id, email, role, password_hash from users where lower(email) = $1', [email]);
  return present(rows[0]);
}
