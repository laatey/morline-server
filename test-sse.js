import assert from 'node:assert';

const BASE_URL = 'http://127.0.0.1:3001/v1';

async function testSSE() {
  console.log('📡 Testing SSE Endpoints...\n');

  // 1. Signup user to get token
  const signupRes = await fetch(`${BASE_URL}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `sse_${Date.now()}@morline.dev`,
      password: 'SuperSecretPassword123!',
      name: 'SSE Tester'
    })
  });
  const { user, session } = await signupRes.json();
  const token = session.accessToken;
  const headers = { Authorization: `Bearer ${token}` };

  // 2. Create Project & Environment
  const teamId = (await (await fetch(`${BASE_URL}/me`, { headers })).json()).teams[0].id;
  const projRes = await (await fetch(`${BASE_URL}/teams/${teamId}/projects`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'sse-project', source: 'empty' })
  })).json();
  const envId = projRes.defaultEnvironmentId;

  // 3. Test Environment Events SSE stream
  console.log('1. Connecting to /environments/:id/events SSE stream...');
  const controller = new AbortController();
  const eventRes = await fetch(`${BASE_URL}/environments/${envId}/events`, {
    headers: { ...headers, Accept: 'text/event-stream' },
    signal: controller.signal
  });
  assert.strictEqual(eventRes.status, 200);
  assert.strictEqual(eventRes.headers.get('content-type'), 'text/event-stream');
  console.log('   ✅ Environment events SSE stream connected (Content-Type: text/event-stream)');

  // 4. Test Notifications SSE stream
  console.log('2. Connecting to /notifications/stream SSE stream...');
  const notifRes = await fetch(`${BASE_URL}/notifications/stream`, {
    headers: { ...headers, Accept: 'text/event-stream' },
    signal: controller.signal
  });
  assert.strictEqual(notifRes.status, 200);
  assert.strictEqual(notifRes.headers.get('content-type'), 'text/event-stream');
  console.log('   ✅ Notifications SSE stream connected (Content-Type: text/event-stream)');

  controller.abort();
  console.log('\n🎉 ALL SSE TESTS PASSED!\n');
}

testSSE().catch(err => {
  if (err.name !== 'AbortError') {
    console.error('SSE Test Error:', err);
    process.exit(1);
  } else {
    console.log('\n🎉 ALL SSE TESTS PASSED!\n');
  }
});
