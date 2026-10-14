import crypto from 'node:crypto';
import { execute, queryOne, transaction } from '../db/index.js';
import { mapService, mapConnection } from '../db/mappers.js';
import { eventBus } from '../engine/event-bus.js';
import { connectionInfo } from '../engine/database-manager.js';
import { provisionTemplate } from '../templates/catalog.js';
import { destroyService } from './service-cleanup.js';
import { startDeployment } from './service-factory.js';

const rid = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** Addon kind (from the module engine's catalog) to the platform's database template. */
const TEMPLATE_FOR_KIND = { postgres: 'postgres', mongodb: 'mongodb', redis: 'redis' };
export const ADDON_KINDS = Object.keys(TEMPLATE_FOR_KIND);

/**
 * Create a database of `kind` next to the app, connect the app to it and give the app the variable
 * the generated code reads (`env`, for example DATABASE_URL).
 *
 * Runs only when the create_app action is applied, never at proposal time. Everything it creates is
 * returned so the action can record it and undo it.
 *
 * @returns {{ kind: string, env: string, serviceId: string, serviceName: string, connectionId: string, variableId: string, deploymentId: string }}
 */
export function provisionAddon({ environmentId, appServiceId, appName, kind, env, userId = null }) {
  const templateId = TEMPLATE_FOR_KIND[kind];
  if (!templateId) throw new Error(`Unsupported addon: ${kind}`);
  if (!/^[A-Z][A-Z0-9_]*$/.test(env || '')) throw new Error(`Invalid variable name for the ${kind} addon: ${env}`);
  const environment = queryOne('SELECT * FROM environments WHERE id = ?', environmentId);
  if (!environment) throw new Error('The environment for this app no longer exists');

  const base = `${appName}-${kind}`.slice(0, 40);
  let serviceName = base;
  for (let i = 2; queryOne('SELECT 1 AS x FROM services WHERE environment_id = ? AND name = ?', environmentId, serviceName); i++) {
    serviceName = `${base}-${i}`;
  }
  const template = queryOne('SELECT kind, logo FROM templates WHERE id = ?', templateId);
  const count = queryOne('SELECT COUNT(*) AS c FROM services WHERE environment_id = ?', environmentId)?.c || 0;
  const serviceId = rid('srv');
  const connectionId = rid('con');
  const variableId = rid('var');
  const now = new Date().toISOString();

  transaction(() => {
    execute(`
      INSERT INTO services (id, environment_id, name, kind, logo, status, position_x, position_y, source_type, source_template_id, source_display, region, replicas, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'created', ?, ?, 'template', ?, ?, 'us-east-1', 1, ?, ?)
    `, serviceId, environmentId, serviceName, template?.kind || 'database', template?.logo || templateId,
      100 + (count % 4) * 280, 100 + Math.floor(count / 4) * 200, templateId, serviceName, now, now);
    execute(`
      INSERT INTO service_settings (service_id, auto_deploy, healthcheck_path, healthcheck_timeout_sec, restart_policy, replicas)
      VALUES (?, 0, '/', 30, 'on-failure', 1)
    `, serviceId);
    execute('INSERT INTO service_networking (service_id, public, target_port) VALUES (?, 0, 3000)', serviceId);
    // Points the service at its template folder and creates its credentials and data volume.
    provisionTemplate(serviceId, templateId, now);
  });

  const dbRow = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
  const info = connectionInfo(dbRow);
  if (!info.url) throw new Error(`Could not work out how to connect to the new ${kind} database`);

  transaction(() => {
    execute(`
      INSERT INTO variables (id, scope_type, scope_id, key, value, secret, created_at, updated_at)
      VALUES (?, 'service', ?, ?, ?, 1, ?, ?)
      ON CONFLICT(scope_type, scope_id, key) DO UPDATE SET value = excluded.value, secret = 1, updated_at = excluded.updated_at
    `, variableId, appServiceId, env, info.url, now, now);
    execute(`
      INSERT INTO connections (id, environment_id, from_service_id, to_service_id, protocol, port, label, created_at)
      VALUES (?, ?, ?, ?, 'tcp', ?, ?, ?)
    `, connectionId, environmentId, appServiceId, serviceId, info.port, `tcp :${info.port}`, now);
  });

  eventBus.emitEnvironmentEvent(environmentId, { type: 'service.created', at: now, actorId: userId, canvasRevision: environment.canvas_revision, data: mapService(dbRow) });
  eventBus.emitEnvironmentEvent(environmentId, { type: 'connection.created', at: now, actorId: userId, canvasRevision: environment.canvas_revision, data: mapConnection(queryOne('SELECT * FROM connections WHERE id = ?', connectionId)) });

  const deploymentId = startDeployment({ serviceId, userId, message: `Database for ${appName}` });
  return { kind, env, serviceId, serviceName, connectionId, variableId, deploymentId };
}

/** Undo provisionAddon: remove the database service (which takes its connection with it). */
export async function removeAddon(addon) {
  if (addon?.serviceId) await destroyService(addon.serviceId);
}
