import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import app, { validateFlightQuery, resolveProviders, configureRetries } from '../server.js';

// The server resolves global fetch at call time, so tests can stub the providers.
// Local HTTP calls must use this captured reference, never globalThis.fetch.
const realFetch = globalThis.fetch;
const ENV_KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'AI_PROVIDER', 'OPENAI_TRANSCRIBE_MODEL', 'OPENAI_COACH_MODEL', 'GEMINI_MODEL', 'AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET', 'AMADEUS_ENV', 'PORT'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

function setEnv(values) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}
function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    json: async () => body
  };
}
function mockProviders(handler) { globalThis.fetch = async (url, init) => handler(url, init); }
async function withServer(fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
}
function audioForm() {
  const form = new FormData();
  form.append('audio', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/webm' }), 'audio.webm');
  return form;
}
const geminiTranscript = text => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text }) }] } }] });
const geminiCoaching = () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ say: 'Ask about dates.', insight: 'Wants flexibility.', next: 'When do you need to fly?', technique: 'Discovery' }) }] } }] });

beforeEach(() => {
  setEnv({});
  configureRetries({ maxRetries: 2, baseMs: 0, maxMs: 0, sleep: async () => {} });
  globalThis.fetch = realFetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
});

test('validates flight searches', () => {
  const valid = { origin:'JFK', destination:'LHR', departureDate:'2027-04-01', travelClass:'BUSINESS', adults:'1' };
  assert.equal(validateFlightQuery(valid), '');
  assert.match(validateFlightQuery({...valid,origin:'New York'}), /three-letter/);
  assert.match(validateFlightQuery({...valid,departureDate:'2027-02-30'}), /departure/);
  assert.match(validateFlightQuery({...valid,returnDate:'2027-03-01'}), /return/);
  assert.match(validateFlightQuery({...valid,adults:'10'}), /adults/);
  assert.match(validateFlightQuery({...valid,travelClass:'PRIVATE'}), /cabin/);
});

test('provider selection honours explicit and auto modes', () => {
  setEnv({}); assert.deepEqual(resolveProviders().providers, []);
  setEnv({ OPENAI_API_KEY: 'sk-test' }); assert.deepEqual(resolveProviders().providers, ['openai']);
  setEnv({ GEMINI_API_KEY: 'AIza-test' }); assert.deepEqual(resolveProviders().providers, ['gemini']);
  setEnv({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'AIza-test', AI_PROVIDER: 'gemini' });
  assert.deepEqual(resolveProviders().providers, ['gemini']);
  setEnv({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'AIza-test', AI_PROVIDER: 'openai' });
  assert.deepEqual(resolveProviders().providers, ['openai']);
  setEnv({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'AIza-test', AI_PROVIDER: 'auto' });
  assert.deepEqual(resolveProviders().providers, ['openai', 'gemini']);
  setEnv({ GEMINI_API_KEY: 'AIza-test', AI_PROVIDER: 'openai' });
  assert.match(resolveProviders().reason, /OpenAI API key/);
});

test('status and unconfigured services give actionable responses', async () => {
  setEnv({});
  await withServer(async url => {
    const status = await (await realFetch(`${url}/api/status`)).json();
    assert.equal(status.ai, false);
    assert.deepEqual(status.providers, { openai: false, gemini: false });
    assert.equal(status.provider, 'auto');
    assert.equal(status.primary, null);
    assert.equal(status.flights, false);
    assert.equal(status.flightEnvironment, 'test');
    const coach = await realFetch(`${url}/api/coach`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({transcript:'hello'}) });
    assert.equal(coach.status, 503); assert.match((await coach.json()).error, /API key in Settings/);
    assert.equal((await realFetch(`${url}/api/flights`)).status, 503);
    const test = await (await realFetch(`${url}/api/test`)).json();
    assert.equal(test.results[0].code, 'not_configured');
    assert.equal((await realFetch(url)).status, 200);
  });
});

test('a 429 rate limit is retried with backoff and then succeeds', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-test', AI_PROVIDER: 'openai' });
  const calls = [];
  mockProviders(async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return jsonResponse(429, { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached, try again in 1s.' } }, { 'retry-after': '0' });
    return jsonResponse(200, { text: 'I need a flight to Rome' });
  });
  await withServer(async url => {
    const response = await realFetch(`${url}/api/transcribe`, { method:'POST', body: audioForm() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'I need a flight to Rome', provider: 'openai' });
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /api\.openai\.com\/v1\/audio\/transcriptions/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.ok(calls[0].init.body instanceof FormData);
  assert.ok(calls[1].init.body instanceof FormData); // body rebuilt for the retry
});

test('insufficient quota is not retried and reports a billing-specific code', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-test', AI_PROVIDER: 'openai' });
  let calls = 0;
  mockProviders(async () => {
    calls++;
    return jsonResponse(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } });
  });
  await withServer(async url => {
    const response = await realFetch(`${url}/api/transcribe`, { method:'POST', body: audioForm() });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.code, 'quota_exhausted');
    assert.match(body.error, /billing/);
    assert.equal(body.provider, 'openai');
  });
  assert.equal(calls, 1); // retrying could never fix a quota problem
});

test('auto mode falls back to Gemini when OpenAI is out of quota', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'AIza-test', AI_PROVIDER: 'auto' });
  const calls = [];
  mockProviders(async (url, init) => {
    calls.push(url);
    if (url.includes('api.openai.com')) return jsonResponse(429, { error: { code: 'insufficient_quota', message: 'No billing.' } });
    assert.equal(init.headers['x-goog-api-key'], 'AIza-test');
    const payload = JSON.parse(init.body);
    assert.equal(payload.contents[0].parts[1].inline_data.mime_type, 'audio/webm');
    assert.equal(payload.contents[0].parts[1].inline_data.data, Buffer.from('fake audio bytes').toString('base64'));
    return jsonResponse(200, geminiTranscript('Fallback transcript'));
  });
  await withServer(async url => {
    const response = await realFetch(`${url}/api/transcribe`, { method:'POST', body: audioForm() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'Fallback transcript', provider: 'gemini' });
  });
  assert.equal(calls.length, 2);
});

test('an invalid OpenAI key falls back to Gemini for coaching', async () => {
  setEnv({ OPENAI_API_KEY: 'bad', GEMINI_API_KEY: 'AIza-test', AI_PROVIDER: 'auto' });
  mockProviders(async url => {
    if (url.includes('api.openai.com')) return jsonResponse(401, { error: { code: 'invalid_api_key', message: 'Incorrect API key provided.' } });
    return jsonResponse(200, geminiCoaching());
  });
  await withServer(async url => {
    const response = await realFetch(`${url}/api/coach`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ transcript:'Customer: I need a flexible ticket.' }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, 'gemini');
    assert.equal(body.say, 'Ask about dates.');
    assert.equal(body.technique, 'Discovery');
  });
});

test('Gemini-only mode builds the right audio and coaching requests', async () => {
  setEnv({ GEMINI_API_KEY: 'AIza-test', AI_PROVIDER: 'gemini', GEMINI_MODEL: 'gemini-test-model' });
  const seen = [];
  mockProviders(async (url, init) => {
    seen.push({ url, init });
    const payload = JSON.parse(init.body);
    if (payload.contents?.[0]?.parts?.some(part => part.inline_data)) return jsonResponse(200, geminiTranscript('Gemini heard this'));
    return jsonResponse(200, geminiCoaching());
  });
  await withServer(async url => {
    const transcript = await realFetch(`${url}/api/transcribe`, { method:'POST', body: audioForm() });
    assert.deepEqual(await transcript.json(), { text: 'Gemini heard this', provider: 'gemini' });
    const coach = await realFetch(`${url}/api/coach`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ transcript:'Customer: hello' }) });
    assert.equal((await coach.json()).say, 'Ask about dates.');
  });
  assert.match(seen[0].url, /gemini-test-model:generateContent/);
  assert.equal(seen[0].init.headers['x-goog-api-key'], 'AIza-test');
  assert.equal(JSON.parse(seen[0].init.body).generationConfig.responseMimeType, 'application/json');
  assert.match(JSON.parse(seen[1].init.body).systemInstruction.parts[0].text, /ethical flight-ticket sales copilot/);
});

test('/api/test reports each configured provider without sending audio', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'AIza-test' });
  const urls = [];
  mockProviders(async url => {
    urls.push(url);
    if (url.includes('api.openai.com')) return jsonResponse(200, { data: [{ id: 'gpt-4.1' }] });
    return jsonResponse(200, { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' });
  });
  await withServer(async url => {
    const response = await realFetch(`${url}/api/test`);
    assert.equal(response.status, 200);
    const results = (await response.json()).results;
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(r => r.provider).sort(), ['gemini', 'openai']);
    assert.ok(results.every(r => r.ok));
    assert.equal(results.find(r => r.provider === 'openai').detail, '1 models listed');
    assert.equal(results.find(r => r.provider === 'gemini').detail, 'Gemini 2.5 Flash');
  });
  assert.ok(urls.every(url => !url.includes(':generateContent')));
});

test('/api/test surfaces a rejected key with a stable code', async () => {
  setEnv({ OPENAI_API_KEY: 'bad' });
  mockProviders(async () => jsonResponse(401, { error: { code: 'invalid_api_key', message: 'Incorrect API key provided.' } }));
  await withServer(async url => {
    const results = (await (await realFetch(`${url}/api/test`)).json()).results;
    assert.equal(results[0].ok, false);
    assert.equal(results[0].code, 'invalid_key');
    assert.match(results[0].message, /ChatGPT subscription is not an API key/);
  });
});

test('network failures are retried before giving up', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-test', AI_PROVIDER: 'openai' });
  configureRetries({ maxRetries: 2, baseMs: 0, maxMs: 0, sleep: async () => {} });
  let calls = 0;
  mockProviders(async () => { calls++; throw new Error('ECONNRESET'); });
  await withServer(async url => {
    const response = await realFetch(`${url}/api/transcribe`, { method:'POST', body: audioForm() });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'network_error');
  });
  assert.equal(calls, 3);
});
