export function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    emailVerified: Boolean(row.email_verified),
    name: row.name,
    username: row.username || null,
    avatarUrl: row.avatar_url || null,
    createdAt: row.created_at
  };
}

export function mapUserRef(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    username: row.username || null,
    avatarUrl: row.avatar_url || null
  };
}

export function mapUserSettings(row) {
  if (!row) {
    return {
      theme: 'system',
      defaultTeamId: null,
      canvasSnapToGrid: true,
      timezone: 'UTC',
      emailNotifications: true
    };
  }
  return {
    theme: row.theme || 'system',
    defaultTeamId: row.default_team_id || null,
    canvasSnapToGrid: Boolean(row.canvas_snap_to_grid),
    timezone: row.timezone || 'UTC',
    emailNotifications: Boolean(row.email_notifications)
  };
}

export function mapOnboardingState(row) {
  let customData = {};
  if (row?.data) {
    try {
      customData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch {
      customData = {};
    }
  }

  if (!row) {
    return {
      step: 0,
      completed: false,
      workspaceName: null,
      selectedTemplate: null,
      invitedEmails: null,
      data: {},
      teamCreated: false,
      githubConnected: false,
      firstProjectCreated: false,
      firstDeploySucceeded: false,
      dismissed: false,
      updatedAt: null
    };
  }

  return {
    step: row.step ?? 0,
    completed: Boolean(row.completed),
    workspaceName: row.workspace_name || null,
    selectedTemplate: row.selected_template || null,
    invitedEmails: row.invited_emails || null,
    data: customData,
    teamCreated: Boolean(row.team_created),
    githubConnected: Boolean(row.github_connected),
    firstProjectCreated: Boolean(row.first_project_created),
    firstDeploySucceeded: Boolean(row.first_deploy_succeeded),
    dismissed: Boolean(row.dismissed),
    updatedAt: row.updated_at || null
  };
}

export function mapSessionInfo(row, currentSessionId) {
  if (!row) return null;
  return {
    id: row.id,
    current: row.id === currentSessionId,
    userAgent: row.user_agent || 'Unknown Client',
    ip: row.ip || '127.0.0.1',
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at
  };
}

export function mapTeam(row, role = 'owner', memberCount = 1) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan || 'hobby',
    role: row.role || role,
    memberCount: row.member_count !== undefined ? Number(row.member_count) : memberCount,
    createdAt: row.created_at
  };
}

export function mapMember(userRef, role = 'member', joinedAt = new Date().toISOString()) {
  return {
    user: userRef,
    role,
    joinedAt
  };
}

export function mapProject(row, isFavorite = false) {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    description: row.description || null,
    settings: {
      prEnvironments: Boolean(row.settings_pr_environments),
      spendLimitUsd: row.settings_spend_limit_usd !== null && row.settings_spend_limit_usd !== undefined ? Number(row.settings_spend_limit_usd) : null,
      defaultRegion: row.settings_default_region || 'us-east-1',
      baseEnvironmentId: row.settings_base_environment_id || null
    },
    defaultEnvironmentId: row.default_environment_id,
    favorite: row.favorite !== undefined ? Boolean(row.favorite) : Boolean(isFavorite),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapEnvironment(row, serviceCount = 0) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    type: row.type || 'development',
    protected: Boolean(row.protected),
    pullRequest: row.pull_request !== null && row.pull_request !== undefined ? Number(row.pull_request) : null,
    forkedFromEnvironmentId: row.forked_from_environment_id || null,
    serviceCount: row.service_count !== undefined ? Number(row.service_count) : Number(serviceCount),
    createdAt: row.created_at
  };
}

export function mapServiceSource(row) {
  return {
    type: row.source_type || 'template',
    repo: row.source_repo || null,
    branch: row.source_branch || null,
    rootDirectory: row.source_root_dir || null,
    image: row.source_image || null,
    templateId: row.source_template_id || null,
    display: row.source_display || row.name
  };
}

export function mapService(row, extra = {}) {
  if (!row) return null;
  const source = mapServiceSource(row);
  return {
    id: row.id,
    environmentId: row.environment_id,
    name: row.name,
    kind: row.kind || 'app',
    logo: row.logo || 'js',
    status: row.status || 'queued',
    position: {
      x: Number(row.position_x || 0),
      y: Number(row.position_y || 0)
    },
    source,
    region: row.region || 'us-east-1',
    replicas: Number(row.replicas || 1),
    port: row.port !== null && row.port !== undefined ? Number(row.port) : null,
    primaryDomain: row.primary_domain || null,
    volume: extra.volume || null,
    usage: extra.usage || {
      cpuPercent: 0,
      memoryMb: 0,
      memoryLimitMb: extra.memoryLimitMb || 512,
      bandwidthMb24h: 0
    },
    activeDeployment: extra.activeDeployment || null,
    buildingDeployment: extra.buildingDeployment || null,
    cronSchedule: row.cron_schedule || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapServiceDetail(service, settings, topology) {
  return {
    ...service,
    settings: settings || {
      branch: 'main',
      rootDirectory: '/',
      autoDeploy: true,
      buildCommand: null,
      startCommand: null,
      dockerfilePath: null,
      healthcheckPath: '/',
      healthcheckTimeoutSec: 30,
      restartPolicy: 'on-failure',
      replicas: 1
    },
    topology: topology || {
      privateEndpoint: `${service.name}.morline.internal:${service.port || 3000}`,
      publicEndpoints: service.primaryDomain ? [`https://${service.primaryDomain}`] : [],
      dependencies: [],
      consumers: []
    }
  };
}

export function mapConnection(row) {
  if (!row) return null;
  return {
    id: row.id,
    environmentId: row.environment_id,
    fromServiceId: row.from_service_id,
    toServiceId: row.to_service_id,
    protocol: row.protocol || 'http',
    port: row.port !== null && row.port !== undefined ? Number(row.port) : null,
    label: row.label || `${row.protocol || 'http'} :${row.port || 80}`
  };
}

export function mapVolume(row) {
  if (!row) return null;
  return {
    id: row.id,
    serviceId: row.service_id,
    name: row.name,
    mountPath: row.mount_path,
    sizeGb: Number(row.size_gb || 1),
    usedGb: Number(row.used_gb || 0),
    createdAt: row.created_at
  };
}

export function mapVariable(row) {
  if (!row) return null;
  return {
    key: row.key,
    value: Boolean(row.secret) ? '••••••••' : row.value,
    secret: Boolean(row.secret),
    isReference: Boolean(row.is_reference),
    resolvedPreview: row.resolved_preview || null,
    source: row.source || 'user',
    updatedAt: row.updated_at
  };
}

export function mapDomain(row) {
  if (!row) return null;
  let dnsRecords = [];
  try {
    if (row.dns_records) dnsRecords = JSON.parse(row.dns_records);
  } catch (e) {}

  return {
    id: row.id,
    host: row.host,
    serviceId: row.service_id || null,
    serviceName: row.service_name || '',
    kind: row.kind === 'custom' ? 'custom' : 'generated',
    status: row.status || 'active',
    targetPort: row.target_port !== null && row.target_port !== undefined ? Number(row.target_port) : null,
    tls: {
      status: row.tls_configured ? 'valid' : 'issuing',
      label: row.tls_configured ? 'Valid · renews in 90d' : 'Issuing certificate',
      expiresAt: new Date(Date.now() + 90 * 86400000).toISOString()
    },
    dnsRecords,
    lastCheckedAt: row.last_checked_at || new Date().toISOString(),
    error: row.error || null
  };
}

export function mapDeployment(row, createdBy = null) {
  if (!row) return null;
  const commit = row.commit_sha ? {
    sha: row.commit_sha,
    message: row.commit_message || 'Update',
    author: row.commit_author || 'user',
    branch: row.commit_branch || 'main'
  } : null;

  return {
    id: row.id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    environmentId: row.environment_id,
    state: row.state || 'queued',
    trigger: row.trigger || 'manual',
    commit,
    image: row.image || null,
    createdBy: createdBy || {
      id: row.created_by || 'usr_system',
      name: 'System',
      username: 'system',
      avatarUrl: null
    },
    rollbackOfDeploymentId: row.rollback_of_deployment_id || null,
    rollbackable: Boolean(row.rollbackable),
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    durationSec: row.duration_sec !== null && row.duration_sec !== undefined ? Number(row.duration_sec) : null,
    errorSummary: row.error_summary || null
  };
}

export function mapDeploymentDetail(deployment, phases = [], url = null) {
  return {
    ...deployment,
    phases: phases.length > 0 ? phases : [
      { name: 'initialize', status: 'succeeded', startedAt: deployment.createdAt, finishedAt: deployment.startedAt },
      { name: 'build', status: deployment.state === 'failed' ? 'failed' : 'succeeded', startedAt: deployment.startedAt, finishedAt: deployment.finishedAt },
      { name: 'deploy', status: deployment.state === 'active' ? 'succeeded' : 'pending', startedAt: deployment.finishedAt, finishedAt: deployment.finishedAt },
      { name: 'healthcheck', status: deployment.state === 'active' ? 'succeeded' : 'pending', startedAt: deployment.finishedAt, finishedAt: deployment.finishedAt },
      { name: 'release', status: deployment.state === 'active' ? 'succeeded' : 'pending', startedAt: deployment.finishedAt, finishedAt: deployment.finishedAt }
    ],
    url: url || deployment.url || null
  };
}

export function mapLogLine(row) {
  if (!row) return null;
  let attributes = {};
  try {
    if (row.attributes) attributes = JSON.parse(row.attributes);
  } catch (e) {}
  return {
    id: row.id,
    timestamp: row.timestamp,
    serviceId: row.service_id,
    serviceName: row.service_name,
    deploymentId: row.deployment_id,
    replica: Number(row.replica || 0),
    level: row.level || 'info',
    message: row.message,
    attributes
  };
}

export function mapNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    projectId: row.project_id || null,
    targetUrl: row.target_url || null,
    read: Boolean(row.read),
    createdAt: row.created_at
  };
}

export function mapActivity(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    actor: {
      id: row.actor_id || 'system',
      name: row.actor_name || 'System',
      username: row.actor_name ? row.actor_name.toLowerCase().replace(/\s+/g, '-') : 'system',
      avatarUrl: row.actor_avatar_url || null
    },
    actorType: row.actor_type || 'user',
    summary: row.summary,
    projectId: row.project_id,
    environmentId: row.environment_id || null,
    serviceId: row.service_id || null,
    targetUrl: row.target_url || null,
    createdAt: row.created_at
  };
}

export function mapThread(row, createdBy = null, counts = {}) {
  if (!row) return null;
  const lastTime = row.last_activity_at || row.created_at;
  let when = 'now';
  if (lastTime) {
    const diffMs = Date.now() - new Date(lastTime).getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays > 0) when = `${diffDays}d`;
    else if (diffHours > 0) when = `${diffHours}h`;
    else if (diffMins > 0) when = `${diffMins}m`;
    else when = 'now';
  }

  return {
    id: row.id,
    projectId: row.project_id || null,
    environmentId: row.environment_id || null,
    environmentName: row.environment_name || 'production',
    title: row.title,
    archived: Boolean(row.archived),
    when,
    messageCount: Number(counts.messageCount || 0),
    lastMessagePreview: counts.lastMessagePreview || null,
    pendingActionCount: Number(counts.pendingActionCount || 0),
    createdBy: createdBy || {
      id: row.created_by || 'usr_system',
      name: 'System',
      username: 'system',
      avatarUrl: null
    },
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at
  };
}

export function mapMessage(row) {
  if (!row) return null;
  let context = [];
  let toolCalls = [];
  let citations = [];
  let actions = [];
  let error = null;
  let author = null;

  try { if (row.context) context = JSON.parse(row.context); } catch (e) {}
  try { if (row.tool_calls) toolCalls = JSON.parse(row.tool_calls); } catch (e) {}
  try { if (row.citations) citations = JSON.parse(row.citations); } catch (e) {}
  try { if (row.actions) actions = JSON.parse(row.actions); } catch (e) {}
  try { if (row.error) error = JSON.parse(row.error); } catch (e) {}
  try { if (row.author) author = JSON.parse(row.author); } catch (e) {}

  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    status: row.status || 'done',
    content: row.content,
    text: row.content,
    context,
    toolCalls,
    citations,
    actions,
    error,
    feedback: row.feedback || null,
    author,
    createdAt: row.created_at
  };
}

export function mapAction(row) {
  if (!row) return null;
  let targets = [];
  let payload = {};
  let diff = [];
  let result = null;
  let appliedBy = null;

  try { if (row.targets) targets = JSON.parse(row.targets); } catch (e) {}
  try { if (row.payload) payload = JSON.parse(row.payload); } catch (e) {}
  try { if (row.diff) diff = JSON.parse(row.diff); } catch (e) {}
  try { if (row.result) result = JSON.parse(row.result); } catch (e) {}
  try { if (row.applied_by) appliedBy = JSON.parse(row.applied_by); } catch (e) {}

  return {
    id: row.id,
    messageId: row.message_id,
    threadId: row.thread_id,
    type: row.type,
    status: row.status,
    title: row.title,
    description: row.description || '',
    risk: row.risk || 'low',
    reversible: Boolean(row.reversible),
    targets,
    payload,
    diff,
    result,
    appliedBy,
    appliedAt: row.applied_at || null
  };
}

export function mapTemplate(row) {
  if (!row) return null;
  let inputs = [];
  try { if (row.inputs) inputs = JSON.parse(row.inputs); } catch (e) {}
  return {
    id: row.id,
    name: row.name,
    logo: row.logo,
    kind: row.kind,
    group: row.group,
    hint: row.hint || '',
    inputs
  };
}

export function mapRegion(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    countryCode: row.country_code,
    available: Boolean(row.available)
  };
}
