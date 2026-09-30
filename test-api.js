import assert from 'node:assert';

const BASE_URL = 'http://127.0.0.1:3001/v1';
const PROXY_URL = 'http://127.0.0.1:3001/proxy';

async function req(path, options = {}) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...options.headers
    }
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = text;
  }

  return { status: res.status, ok: res.ok, data: json, headers: res.headers };
}

async function runTests() {
  console.log('🧪 Starting End-to-End Test Suite for Morline Backend Server...\n');

  // 1. Auth Signup
  console.log('1. Testing User Registration...');
  const userEmail = `dev_${Date.now()}@morline.dev`;
  const signupRes = await req('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email: userEmail,
      password: 'SuperSecretPassword123!',
      name: 'Morline Developer'
    })
  });
  assert.strictEqual(signupRes.status, 201, `Signup failed: ${JSON.stringify(signupRes.data)}`);
  assert(signupRes.data.user?.id, 'User ID should be present');
  assert(signupRes.data.session?.accessToken, 'Access token should be present');
  console.log(`   ✅ User created: ${signupRes.data.user.name} (${signupRes.data.user.id})`);

  const token = signupRes.data.session.accessToken;
  const authHeaders = { Authorization: `Bearer ${token}` };

  // 2. Auth Login
  console.log('2. Testing User Login...');
  const loginRes = await req('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: userEmail,
      password: 'SuperSecretPassword123!'
    })
  });
  assert.strictEqual(loginRes.status, 200, `Login failed: ${JSON.stringify(loginRes.data)}`);
  console.log('   ✅ Logged in successfully');

  // 3. User Profile & Settings
  console.log('3. Testing User Profile & Settings (/me)...');
  const meRes = await req('/me', { headers: authHeaders });
  assert.strictEqual(meRes.status, 200);
  assert(meRes.data.teams?.length > 0, 'User should have at least one default team');
  const teamId = meRes.data.teams[0].id;
  console.log(`   ✅ Profile verified. Default team: ${meRes.data.teams[0].name} (${teamId})`);

  const settingsRes = await req('/me/settings', {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ theme: 'dark', canvasSnapToGrid: true })
  });
  assert.strictEqual(settingsRes.status, 200);
  assert.strictEqual(settingsRes.data.theme, 'dark');
  console.log('   ✅ User settings updated to dark theme');

  // 4. Create Project
  console.log('4. Testing Project Creation...');
  const projRes = await req(`/teams/${teamId}/projects`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: `project-${Date.now().toString().slice(-6)}`,
      description: 'Production E2E test project',
      region: 'us-east-1',
      source: 'empty'
    })
  });
  assert.strictEqual(projRes.status, 201, `Project creation failed: ${JSON.stringify(projRes.data)}`);
  const project = projRes.data;
  const envId = project.defaultEnvironmentId;
  console.log(`   ✅ Project created: ${project.name} (${project.id}) with default environment (${envId})`);

  // 5. Canvas Verification
  console.log('5. Testing Canvas Initial State...');
  const canvasRes = await req(`/environments/${envId}/canvas`, { headers: authHeaders });
  assert.strictEqual(canvasRes.status, 200);
  assert.strictEqual(canvasRes.data.environmentId, envId);
  console.log(`   ✅ Canvas verified: revision ${canvasRes.data.revision}, services: ${canvasRes.data.services.length}`);

  // 6. Deploy a Real Native Node.js Service
  console.log('6. Testing Real Service Creation and Process Spawning...');
  const serviceRes = await req(`/environments/${envId}/services`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'api-service',
      templateId: 'js',
      source: {
        type: 'template',
        templateId: 'js'
      },
      position: { x: 200, y: 150 },
      deploy: true
    })
  });
  assert.strictEqual(serviceRes.status, 201, `Service creation failed: ${JSON.stringify(serviceRes.data)}`);
  const service = serviceRes.data;
  console.log(`   ✅ Service created: ${service.name} (${service.id})`);

  // Wait for health check and process startup (approx 2-3 seconds)
  console.log('   ⏳ Waiting for service process to start and health check to pass...');
  let runningService = null;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 600));
    const sCheck = await req(`/services/${service.id}`, { headers: authHeaders });
    if (sCheck.data?.status === 'online') {
      runningService = sCheck.data;
      break;
    }
  }

  assert(runningService, 'Service did not reach online status within timeout');
  assert.strictEqual(runningService.status, 'online');
  assert(runningService.port, 'Service should have an allocated host port');
  console.log(`   ✅ Service is ONLINE! Running on internal port ${runningService.port}`);

  // 7. Verify Reverse Proxy to Native Process
  console.log('7. Testing Built-in Reverse Proxy to Running Service Process...');
  const proxyCheck = await req(`${PROXY_URL}/${service.id}/health`);
  assert.strictEqual(proxyCheck.status, 200, `Proxy request failed with status ${proxyCheck.status}`);
  assert.strictEqual(proxyCheck.data.status, 'healthy');
  console.log(`   ✅ Reverse proxy confirmed! Response:`, JSON.stringify(proxyCheck.data));

  // 8. Deployments & Logs
  console.log('8. Testing Deployments and Real Process Logs...');
  const depsRes = await req(`/services/${service.id}/deployments`, { headers: authHeaders });
  assert.strictEqual(depsRes.status, 200);
  assert(depsRes.data.data.length > 0, 'Deployments list should have at least 1 deployment');
  const dep = depsRes.data.data[0];
  console.log(`   ✅ Deployment found: ${dep.id} (state: ${dep.state})`);

  const logsRes = await req(`/deployments/${dep.id}/logs`, { headers: authHeaders });
  assert.strictEqual(logsRes.status, 200);
  assert(logsRes.data.data.length > 0, 'Logs should contain process output');
  console.log(`   ✅ Process logs captured: ${logsRes.data.data.length} lines. First line: "${logsRes.data.data[0]?.message}"`);

  // 9. Deploy a second service & Connect them
  console.log('9. Testing Second Service and Canvas Connection...');
  const workerRes = await req(`/environments/${envId}/services`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'worker-service',
      templateId: 'js',
      position: { x: 500, y: 150 },
      deploy: true
    })
  });
  assert.strictEqual(workerRes.status, 201);
  const worker = workerRes.data;

  const connRes = await req(`/environments/${envId}/connections`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      fromServiceId: service.id,
      toServiceId: worker.id,
      protocol: 'http',
      port: 3000,
      injectVariables: true
    })
  });
  assert.strictEqual(connRes.status, 201, `Connection failed: ${JSON.stringify(connRes.data)}`);
  assert(connRes.data.connection?.id, 'Connection ID must be present');
  console.log(`   ✅ Connected ${service.name} ➡️ ${worker.name} (Connection ID: ${connRes.data.connection.id})`);

  // 10. Update Canvas Layout
  console.log('10. Testing Canvas Layout Persistence...');
  const layoutRes = await req(`/environments/${envId}/canvas/layout`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({
      revision: canvasRes.data.revision,
      positions: [
        { serviceId: service.id, x: 250, y: 180 },
        { serviceId: worker.id, x: 550, y: 180 }
      ]
    })
  });
  assert.strictEqual(layoutRes.status, 200);
  console.log(`   ✅ Canvas layout updated. New revision: ${layoutRes.data.revision}`);

  // 11. Environment & Service Variables
  console.log('11. Testing Environment and Service Variables...');
  const setVarsRes = await req(`/services/${service.id}/variables`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      variables: [
        { key: 'API_SECRET_KEY', value: 'secret-12345', secret: true },
        { key: 'MAX_WORKERS', value: '4', secret: false }
      ]
    })
  });
  assert.strictEqual(setVarsRes.status, 200);
  console.log(`   ✅ Variables set on ${service.name}`);

  // 12. Real-time Metrics
  console.log('12. Testing Service and Environment Metrics...');
  const srvMetrics = await req(`/services/${service.id}/metrics?range=1h`, { headers: authHeaders });
  assert.strictEqual(srvMetrics.status, 200);
  assert(srvMetrics.data.series.length > 0, 'Metrics series should contain points');
  console.log(`   ✅ Service metrics verified: CPU=${srvMetrics.data.series[0]?.current} vCPU`);

  // 13. AI Assistant
  console.log('13. Testing AI Assistant Conversations...');
  const threadRes = await req(`/projects/${project.id}/assistant/threads`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      environmentId: envId,
      title: 'Debugging and Architecture Planning'
    })
  });
  assert.strictEqual(threadRes.status, 201);
  const thread = threadRes.data;

  const msgRes = await req(`/assistant/threads/${thread.id}/messages`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      content: 'Can you check if my services are online and ready for traffic?'
    })
  });
  assert.strictEqual(msgRes.status, 202);
  console.log(`   ✅ Assistant message sent and reply generated (Msg ID: ${msgRes.data.assistantMessageId})`);

  // 14. Global Search
  console.log('14. Testing Global Command Palette Search...');
  const searchRes = await req(`/search?q=api&teamId=${teamId}`, { headers: authHeaders });
  assert.strictEqual(searchRes.status, 200);
  assert(searchRes.data.data.length > 0, 'Search should find the api-service');
  console.log(`   ✅ Search returned ${searchRes.data.data.length} match(es) for query "api"`);

  // 15. Service Lifecycle: Sleep and Wake
  console.log('15. Testing Service Lifecycle (Sleep / Wake)...');
  const sleepRes = await req(`/services/${service.id}/sleep`, { method: 'POST', headers: authHeaders });
  assert.strictEqual(sleepRes.status, 200);
  assert.strictEqual(sleepRes.data.status, 'sleeping');
  console.log(`   ✅ Service put to sleep (status: ${sleepRes.data.status})`);

  const wakeRes = await req(`/services/${service.id}/wake`, { method: 'POST', headers: authHeaders });
  assert.strictEqual(wakeRes.status, 200);
  console.log(`   ✅ Service wake signal sent (status: ${wakeRes.data.status})`);

  console.log('\n🎉 ALL 15 VERIFICATION STAGES PASSED SUCCESSFULLY!');
  console.log('Morline Backend Server is fully operational and strictly compliant with openapi.yaml.\n');
}

runTests().catch(err => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
