import { queryOne } from '../db/index.js';
import { forbidden } from './error-handler.js';

// Which team owns a resource? One resolver per resource kind. A resolver returns null when the
// resource doesn't exist, so the route's own 404 handling still applies.
const OWNER_SQL = {
  team: 'SELECT id AS team_id FROM teams WHERE id = ?',
  project: 'SELECT team_id FROM projects WHERE id = ?',
  environment: 'SELECT p.team_id FROM environments e JOIN projects p ON p.id = e.project_id WHERE e.id = ?',
  service: 'SELECT p.team_id FROM services s JOIN environments e ON e.id = s.environment_id JOIN projects p ON p.id = e.project_id WHERE s.id = ?',
  deployment: 'SELECT p.team_id FROM deployments d JOIN environments e ON e.id = d.environment_id JOIN projects p ON p.id = e.project_id WHERE d.id = ?',
  domain: 'SELECT p.team_id FROM domains d JOIN environments e ON e.id = d.environment_id JOIN projects p ON p.id = e.project_id WHERE d.id = ?',
  volume: 'SELECT p.team_id FROM volumes v JOIN services s ON s.id = v.service_id JOIN environments e ON e.id = s.environment_id JOIN projects p ON p.id = e.project_id WHERE v.id = ?',
  connection: 'SELECT p.team_id FROM connections c JOIN environments e ON e.id = c.environment_id JOIN projects p ON p.id = e.project_id WHERE c.id = ?',
  thread: 'SELECT p.team_id FROM assistant_threads t JOIN projects p ON p.id = t.project_id WHERE t.id = ?'
};

export function ownerTeamOf(kind, id) {
  const sql = OWNER_SQL[kind];
  if (!sql || typeof id !== 'string' || !id) return null;
  return queryOne(sql, id)?.team_id ?? null;
}

export function isTeamMember(teamId, userId) {
  return Boolean(queryOne('SELECT 1 AS ok FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId));
}

// Path prefixes (relative to /v1) that name a resource in their first parameter.
const PATH_RULES = [
  [/^\/projects\/([^/]+)/, 'project'],
  [/^\/environments\/([^/]+)/, 'environment'],
  [/^\/services\/([^/]+)/, 'service'],
  [/^\/deployments\/([^/]+)/, 'deployment'],
  [/^\/domains\/([^/]+)/, 'domain'],
  [/^\/volumes\/([^/]+)/, 'volume'],
  [/^\/connections\/([^/]+)/, 'connection'],
  [/^\/assistant\/threads\/([^/]+)/, 'thread']
];

// Query-string and JSON-body fields that reference a resource.
const FIELD_KINDS = {
  teamId: 'team', projectId: 'project', environmentId: 'environment',
  serviceId: 'service', fromServiceId: 'service', toServiceId: 'service'
};

/**
 * Tenant isolation in one place: for an authenticated request, every resource it references (by
 * path, query string or body) must belong to a team the caller is a member of. Unknown ids pass
 * through to the route's normal 404. Unauthenticated requests are left to each router's requireAuth.
 */
export function enforceTenancy(req, res, next) {
  try {
    if (!req.user) return next();
    const refs = [];
    for (const [re, kind] of PATH_RULES) {
      const m = re.exec(req.path);
      if (m) refs.push([kind, decodeURIComponent(m[1])]);
    }
    for (const source of [req.query, req.body]) {
      if (!source || typeof source !== 'object') continue;
      for (const [field, kind] of Object.entries(FIELD_KINDS)) {
        if (typeof source[field] === 'string') refs.push([kind, source[field]]);
      }
    }
    for (const [kind, id] of refs) {
      const teamId = ownerTeamOf(kind, id);
      if (teamId && !isTeamMember(teamId, req.user.id)) {
        return next(forbidden('You do not have access to this resource'));
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}
