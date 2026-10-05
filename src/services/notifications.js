import crypto from 'node:crypto';
import { execute, queryOne, queryAll } from '../db/index.js';
import { eventBus } from '../engine/event-bus.js';
import { mapNotification } from '../db/mappers.js';
import { sendNotificationEmail } from './email.js';
import { FRONTEND_URL } from '../config.js';

/**
 * One place that creates notifications: it saves the inbox entry, pushes it to any open tab,
 * and emails the user when they have email notifications on and the event is worth an email.
 * Types match the API spec: deploy_failed, deploy_succeeded, service_crashed, domain_active,
 * domain_failed, spend_limit, invite, assistant_action.
 */

const EMAIL_WORTHY = new Set(['deploy_failed', 'service_crashed', 'domain_failed', 'spend_limit', 'invite']);

export function notify(userIds, { type, title, body, projectId = null, targetUrl = null, dedupeKey = null }) {
  const created = [];
  for (const userId of new Set([userIds].flat().filter(Boolean))) {
    // dedupeKey is matched against the type, user and project so a flapping service cannot flood an inbox.
    if (dedupeKey && queryOne(
      'SELECT 1 AS found FROM notifications WHERE user_id = ? AND type = ? AND COALESCE(project_id, \'\') = ? AND title = ? AND created_at > ?',
      userId, type, projectId || '', title, dedupeKey)) continue;

    const id = `ntf_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    const url = targetUrl ? (targetUrl.startsWith('http') ? targetUrl : `${FRONTEND_URL}${targetUrl}`) : null;
    execute(`INSERT INTO notifications (id, user_id, type, title, body, project_id, target_url, read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`, id, userId, type, title, body, projectId, url, now);
    eventBus.emitNotification(userId, mapNotification(queryOne('SELECT * FROM notifications WHERE id = ?', id)));
    created.push(id);

    if (EMAIL_WORTHY.has(type)) {
      const user = queryOne(`SELECT u.email, u.name, s.email_notifications FROM users u
        LEFT JOIN user_settings s ON s.user_id = u.id WHERE u.id = ?`, userId);
      if (user && (user.email_notifications === null || user.email_notifications === undefined || user.email_notifications)) {
        sendNotificationEmail({ to: user.email, name: user.name, title, body, url }).catch(() => {});
      }
    }
  }
  return created;
}

/** Owners and admins of the workspace that owns a project. */
export function adminsOfProject(projectId) {
  return queryAll(`SELECT tm.user_id FROM team_members tm JOIN projects p ON p.team_id = tm.team_id
    WHERE p.id = ? AND tm.role IN ('owner', 'admin')`, projectId).map((r) => r.user_id);
}

export function projectOfEnvironment(environmentId) {
  return queryOne('SELECT project_id FROM environments WHERE id = ?', environmentId)?.project_id || null;
}

/** Who should hear about a deployment: whoever triggered it, otherwise the workspace's owners and admins. */
export function recipientsForDeployment(deploymentId) {
  const dep = queryOne('SELECT created_by, environment_id FROM deployments WHERE id = ?', deploymentId);
  if (!dep) return { users: [], projectId: null };
  const projectId = projectOfEnvironment(dep.environment_id);
  return { users: dep.created_by ? [dep.created_by] : (projectId ? adminsOfProject(projectId) : []), projectId };
}

export const projectLink = (projectId) => (projectId ? `/projects/${projectId}` : '/projects');
