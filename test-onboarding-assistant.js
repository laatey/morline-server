import assert from 'node:assert';

const BASE_URL = 'http://127.0.0.1:3001/v1';

async function test() {
  console.log('🧪 Testing Onboarding & AI Assistant Chat Persistence...');

  // 1. Create a user session
  const email = `test_${Date.now()}@morline.space`;
  const regRes = await fetch(`${BASE_URL}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Tester', email, password: 'Password123!' })
  });
  const auth = await regRes.json();
  const token = auth.session?.accessToken;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  console.log('1. Testing GET /me/onboarding...');
  const obGet = await fetch(`${BASE_URL}/me/onboarding`, { headers });
  assert.strictEqual(obGet.status, 200);
  const obData = await obGet.json();
  assert.strictEqual(obData.step, 0);
  console.log('   ✅ Initial onboarding state:', obData);

  console.log('2. Testing PATCH /me/onboarding to save step 1 & workspaceName...');
  const obPatch = await fetch(`${BASE_URL}/me/onboarding`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ step: 1, workspaceName: 'Acme Cloud' })
  });
  assert.strictEqual(obPatch.status, 200);
  const obPatched = await obPatch.json();
  assert.strictEqual(obPatched.step, 1);
  assert.strictEqual(obPatched.workspaceName, 'Acme Cloud');
  console.log('   ✅ Saved step 1:', obPatched.workspaceName);

  console.log('3. Testing POST /me/onboarding to save step 2, template, and custom data...');
  const obPost = await fetch(`${BASE_URL}/me/onboarding`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ step: 2, selectedTemplate: 'Node.js Express', data: { survey: 'completed' } })
  });
  assert.strictEqual(obPost.status, 200);
  const obPosted = await obPost.json();
  assert.strictEqual(obPosted.step, 2);
  assert.strictEqual(obPosted.selectedTemplate, 'Node.js Express');
  assert.strictEqual(obPosted.data.survey, 'completed');
  console.log('   ✅ Saved step 2 and custom data:', obPosted.selectedTemplate);

  console.log('4. Testing GET /me includes full onboarding progress...');
  const meRes = await fetch(`${BASE_URL}/me`, { headers });
  assert.strictEqual(meRes.status, 200);
  const me = await meRes.json();
  assert.strictEqual(me.onboarding.step, 2);
  assert.strictEqual(me.onboarding.workspaceName, 'Acme Cloud');
  console.log('   ✅ /me verified with onboarding.step =', me.onboarding.step);

  console.log('5. Testing POST /assistant/threads (Global thread without project/env)...');
  const threadRes = await fetch(`${BASE_URL}/assistant/threads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Debugging deploy' })
  });
  assert.strictEqual(threadRes.status, 201);
  const thread = await threadRes.json();
  assert.ok(thread.id);
  assert.strictEqual(thread.title, 'Debugging deploy');
  console.log('   ✅ Assistant thread created:', thread.id);

  console.log('6. Testing POST /assistant/threads/:id/messages...');
  const msgRes = await fetch(`${BASE_URL}/assistant/threads/${thread.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'Why did the latest deploy fail?' })
  });
  assert.strictEqual(msgRes.status, 202);
  const msgData = await msgRes.json();
  assert.ok(msgData.reply || msgData.text);
  assert.ok(msgData.userMessage);
  console.log('   ✅ Reply received:', (msgData.reply || msgData.text).slice(0, 50) + '...');

  console.log('7. Testing GET /assistant/threads to list conversation with messages...');
  const listRes = await fetch(`${BASE_URL}/assistant/threads`, { headers });
  assert.strictEqual(listRes.status, 200);
  const listData = await listRes.json();
  assert.ok(listData.data.length >= 1);
  const foundThread = listData.data.find(t => t.id === thread.id);
  assert.ok(foundThread);
  assert.strictEqual(foundThread.messages.length, 2); // 1 user + 1 assistant
  console.log('   ✅ Found thread in list with', foundThread.messages.length, 'saved messages');

  console.log('8. Testing auto-provisioning thread from random client ID...');
  const randomId = 'custom_client_' + Date.now();
  const autoMsgRes = await fetch(`${BASE_URL}/assistant/threads/${randomId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: 'Hello assistant!' })
  });
  assert.strictEqual(autoMsgRes.status, 202);
  const autoMsgData = await autoMsgRes.json();
  assert.ok(autoMsgData.reply || autoMsgData.text);
  console.log('   ✅ Auto-provisioned thread', randomId, 'and saved conversation');

  console.log('\n🎉 ALL ONBOARDING & AI ASSISTANT PERSISTENCE TESTS PASSED!');
}

test().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
