import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

const coachPrompt = `You are an expert, ethical flight-ticket sales copilot. Give the agent a fast response to read aloud, grounded only in the transcript and context provided. Use the user's sales framework: thorough discovery before pitching; reflect the customer's exact language; ask about goals, dates, cabin, budget and constraints when relevant; address the real concern with empathy, not arguments; offer a specific helpful next step and, where appropriate, explore the cost of waiting without pressure. Respect a no or a request for time. Price and budget can be genuine constraints. Never invent flight availability, prices, policies, guarantees, urgency, testimonials or customer facts. Do not claim to have searched flights unless results are provided. Do not provide medical advice. Return only valid JSON with these keys: say (one or two natural, short sentences to read aloud), insight (a short observation about the customer's need or objection), next (one short suggested discovery question or action), technique (a short label). If the transcript is too thin, ask a helpful discovery question instead of guessing.`;

const DEFAULTS = { transcribe: 'gpt-4o-mini-transcribe', coach: 'gpt-4.1', gemini: 'gemini-2.5-flash' };
const setting = (name, fallback) => process.env[name] || fallback;
const openaiTranscribeModel = () => setting('OPENAI_TRANSCRIBE_MODEL', DEFAULTS.transcribe);
const openaiCoachModel = () => setting('OPENAI_COACH_MODEL', DEFAULTS.coach);
const geminiModel = () => setting('GEMINI_MODEL', DEFAULTS.gemini);
const geminiGenerateUrl = () => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel())}:generateContent`;

// Which AI providers are usable right now. 'auto' prefers OpenAI and falls back to Gemini.
// Fallback is deliberately explicit: in Auto mode call audio/transcripts may reach both providers.
export function resolveProviders() {
  const configured = { openai: Boolean(process.env.OPENAI_API_KEY), gemini: Boolean(process.env.GEMINI_API_KEY) };
  const requested = String(process.env.AI_PROVIDER || 'auto').toLowerCase();
  const mode = ['auto', 'openai', 'gemini'].includes(requested) ? requested : 'auto';
  let providers;
  if (mode === 'openai') providers = configured.openai ? ['openai'] : [];
  else if (mode === 'gemini') providers = configured.gemini ? ['gemini'] : [];
  else providers = ['openai', 'gemini'].filter(provider => configured[provider]);
  let reason = '';
  if (!providers.length) {
    reason = mode === 'auto'
      ? 'Add an OpenAI or Gemini API key in Settings to enable transcription and coaching.'
      : `Add a ${mode === 'openai' ? 'OpenAI' : 'Gemini'} API key in Settings, or set the AI provider to Auto.`;
  }
  return { mode, configured, providers, reason };
}

async function readJson(response) {
  try { return await response.json(); } catch { return {}; }
}

// Turn provider failures into safe, actionable messages. Upstream text is never relayed to the
// browser (it can echo call audio or credentials); only a stable code and a canned message are.
function normalizeError(status, body, label) {
  const details = Array.isArray(body?.error?.details) ? JSON.stringify(body.error.details) : '';
  const parts = [
    body?.error?.code, body?.error?.status, body?.error?.type, body?.error?.message,
    body?.error_description, body?.message, details,
    ...(Array.isArray(body?.errors) ? body.errors.flatMap(e => [e?.reason, e?.message, e?.detail]) : [])
  ].filter(Boolean);
  const raw = parts.join(' ').toLowerCase();
  const has = term => raw.includes(term);
  const base = {
    status,
    code: 'provider_error',
    message: `${label} failed (provider returned ${status}). Check your credentials, account access and server logs.`,
    retryable: false,
    fallback: true
  };
  if (status === 401 || has('api_key_invalid') || has('unauthenticated') || has('invalid_api_key') || has('incorrect api key') || has('invalid api key') || has('invalid key')) {
    return { ...base, code: 'invalid_key', message: `${label}: the API key was rejected. Open Settings, check the key, and confirm the account has API access (a ChatGPT subscription is not an API key).` };
  }
  if (status === 403 || has('permission_denied') || has('access_denied')) {
    return { ...base, code: 'no_access', message: `${label}: this key cannot use the selected model. Check model access, billing, or change the model/provider in Settings.` };
  }
  if (has('insufficient_quota') || has('billing_hard_limit') || has('quota_exceeded') || has('billing_hard')) {
    return { ...base, code: 'quota_exhausted', message: `${label}: this API key is out of quota or has no billing configured. Add credits/billing in the provider console, or switch the AI provider in Settings.` };
  }
  if (status === 429 && (has('rate_limit') || has('rate limit') || has('too many requests') || has('requests per minute') || has('rpm') || has('tokens per minute') || has('retry_delay'))) {
    return { ...base, code: 'rate_limited', message: `${label}: the provider rate limit was reached. Flightdesk retries with backoff; if it keeps happening, use one audio source or upgrade the plan.`, retryable: true };
  }
  if (status === 429 && (has('quota') || has('resource_exhausted') || has('free_tier'))) {
    return { ...base, code: 'quota_exhausted', message: `${label}: this API key is out of quota or has no billing configured. Add credits/billing in the provider console, or switch the AI provider in Settings.` };
  }
  if (status === 429) {
    return { ...base, code: 'rate_limited', message: `${label}: the provider rate limit was reached. Flightdesk retries with backoff.`, retryable: true };
  }
  if (status === 404 && (has('model') || has('not found'))) {
    return { ...base, code: 'model_unavailable', message: `${label}: the configured model is unavailable for this key. Update the model under Advanced in Settings, or switch provider.` };
  }
  if (status >= 500) {
    return { ...base, code: 'provider_unavailable', message: `${label}: the provider is temporarily unavailable. Flightdesk will retry.`, retryable: true };
  }
  if (status === 400 && (has('audio') || has('mime') || has('format') || has('unsupported'))) {
    return { ...base, code: 'audio_format', message: `${label}: this provider rejected the audio format. Try Chrome, use one audio source, or switch AI provider.` };
  }
  return base;
}

let retryConfig = { maxRetries: 2, baseMs: 400, maxMs: 4000, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export function configureRetries(patch) { retryConfig = { ...retryConfig, ...patch }; }

function backoffMs(response, attempt) {
  const header = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header >= 0) return Math.min(header * 1000, 8000);
  return Math.min(retryConfig.baseMs * 2 ** attempt, retryConfig.maxMs) + Math.floor(Math.random() * 75);
}

// makeInit() is called per attempt so FormData/streams are rebuilt on every retry.
async function providerFetch(url, makeInit, label, maxRetries = retryConfig.maxRetries) {
  let response, error;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      response = await fetch(url, makeInit());
      if (response.ok) return { ok: true, response };
      error = normalizeError(response.status, await readJson(response), label);
    } catch {
      response = undefined;
      error = { status: 0, code: 'network_error', message: `${label}: could not reach the AI provider. Check your connection and try again.`, retryable: true, fallback: true };
    }
    if (!error.retryable || attempt === maxRetries) break;
    const delay = backoffMs(response, attempt);
    console.error(`${label}: ${error.code}${error.status ? ` (${error.status})` : ''}, retrying in ${delay}ms`);
    await retryConfig.sleep(delay);
  }
  console.error(`${label}: ${error.code}${error.status ? ` (${error.status})` : ''}`);
  return { ok: false, error };
}

async function finish(out, label, extract) {
  if (!out.ok) return out;
  try {
    const body = await out.response.json();
    return { ok: true, data: extract(body) };
  } catch {
    return { ok: false, error: { status: 200, code: 'bad_response', message: `${label}: the provider returned an unexpected response. Try again or switch provider.`, retryable: true, fallback: true } };
  }
}

function parseObject(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Unexpected JSON shape.');
  return parsed;
}
function geminiText(body) {
  const parts = body?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(part => part.text || '').join('').trim();
  if (!text) throw new Error(body?.promptFeedback?.blockReason ? 'Content was blocked.' : 'Empty provider response.');
  return text;
}
function coachFields(result) {
  return {
    say: String(result.say || ''), insight: String(result.insight || ''),
    next: String(result.next || ''), technique: String(result.technique || '')
  };
}

// --- Provider implementations -------------------------------------------------

async function openaiTranscribe(file) {
  const makeInit = () => {
    const form = new FormData();
    form.append('file', new Blob([file.buffer], { type: file.mimetype || 'audio/webm' }), 'audio.webm');
    form.append('model', openaiTranscribeModel());
    form.append('language', 'en');
    return { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(30000) };
  };
  const out = await providerFetch('https://api.openai.com/v1/audio/transcriptions', makeInit, 'Transcription');
  return finish(out, 'Transcription', data => ({ text: typeof data.text === 'string' ? data.text : '' }));
}

async function geminiTranscribe(file) {
  const instruction = 'Transcribe this short audio clip verbatim in English. Ignore music and background noise. Return only a JSON object with a single key "text"; use an empty string when there is no audible speech.';
  const makeInit = () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { text: instruction },
        { inline_data: { mime_type: file.mimetype || 'audio/webm', data: file.buffer.toString('base64') } }
      ] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1024 }
    }),
    signal: AbortSignal.timeout(30000)
  });
  const out = await providerFetch(geminiGenerateUrl(), makeInit, 'Transcription');
  return finish(out, 'Transcription', data => {
    const parsed = parseObject(geminiText(data));
    return { text: typeof parsed.text === 'string' ? parsed.text : '' };
  });
}

async function openaiCoach(transcript, context) {
  const makeInit = () => ({
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: openaiCoachModel(),
      messages: [
        { role: 'system', content: coachPrompt },
        { role: 'user', content: `Agent notes (unverified):\n${context}\n\nCall transcript:\n${transcript}` }
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 250,
      temperature: 0.3
    }),
    signal: AbortSignal.timeout(30000)
  });
  const out = await providerFetch('https://api.openai.com/v1/chat/completions', makeInit, 'Coaching');
  return finish(out, 'Coaching', data => coachFields(parseObject(data.choices?.[0]?.message?.content || '')));
}

async function geminiCoach(transcript, context) {
  const makeInit = () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: coachPrompt }] },
      contents: [{ role: 'user', parts: [{ text: `Agent notes (unverified):\n${context}\n\nCall transcript:\n${transcript}` }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json', maxOutputTokens: 400 }
    }),
    signal: AbortSignal.timeout(30000)
  });
  const out = await providerFetch(geminiGenerateUrl(), makeInit, 'Coaching');
  return finish(out, 'Coaching', data => coachFields(parseObject(geminiText(data))));
}

// Try providers in order; only fall through on provider-side failures.
async function execute(providers, operation) {
  let last;
  const tried = [];
  for (const provider of providers) {
    const result = await operation(provider);
    if (result.ok) return { status: 200, body: { ...result.data, provider } };
    tried.push({ provider, code: result.error.code });
    last = result.error;
    if (!result.error.fallback) break;
  }
  return {
    status: 502,
    body: { error: last.message, code: last.code, provider: tried[tried.length - 1]?.provider || providers[0], tried }
  };
}

// --- Routes --------------------------------------------------------------------

app.get('/api/status', (_req, res) => {
  const { mode, configured, providers } = resolveProviders();
  res.json({
    ai: providers.length > 0,
    providers: configured,
    provider: mode,
    primary: providers[0] || null,
    flights: Boolean(process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET),
    flightEnvironment: process.env.AMADEUS_ENV === 'production' ? 'production' : 'test'
  });
});

// Cheap, non-audio check: does the key authenticate and does the model exist?
async function testProvider(provider) {
  const started = Date.now();
  const label = `Connection test (${provider})`;
  const url = provider === 'openai'
    ? 'https://api.openai.com/v1/models'
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel())}`;
  const makeInit = provider === 'openai'
    ? () => ({ method: 'GET', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, signal: AbortSignal.timeout(8000) })
    : () => ({ method: 'GET', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }, signal: AbortSignal.timeout(8000) });
  const out = await providerFetch(url, makeInit, label, 0);
  const result = { provider, ok: out.ok, latencyMs: Date.now() - started };
  if (!out.ok) return { ...result, code: out.error.code, message: out.error.message };
  const body = await readJson(out.response);
  result.detail = provider === 'openai' ? `${(body.data || []).length} models listed` : (body.displayName || body.name || geminiModel());
  return result;
}

app.get('/api/test', async (_req, res) => {
  const { configured } = resolveProviders();
  const targets = ['openai', 'gemini'].filter(provider => configured[provider]);
  if (!targets.length) return res.json({ results: [{ provider: 'none', ok: false, code: 'not_configured', message: 'Add an OpenAI or Gemini API key in Settings first.' }] });
  try {
    res.json({ results: await Promise.all(targets.map(testProvider)) });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'Could not run the connection test.' });
  }
});

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  const { providers, reason } = resolveProviders();
  if (!req.file) return res.status(400).json({ error: 'Audio is required.' });
  if (!providers.length) return res.status(503).json({ error: reason, code: 'not_configured' });
  const result = await execute(providers, provider => provider === 'openai'
    ? openaiTranscribe(req.file)
    : geminiTranscribe(req.file));
  res.status(result.status).json(result.body);
});

app.post('/api/coach', async (req, res) => {
  const { providers, reason } = resolveProviders();
  const transcript = typeof req.body.transcript === 'string' ? req.body.transcript.slice(-16000) : '';
  const context = typeof req.body.context === 'string' ? req.body.context.slice(0, 2000) : '';
  if (!transcript.trim()) return res.status(400).json({ error: 'A transcript is required.' });
  if (!providers.length) return res.status(503).json({ error: reason, code: 'not_configured' });
  const result = await execute(providers, provider => provider === 'openai'
    ? openaiCoach(transcript, context)
    : geminiCoach(transcript, context));
  res.status(result.status).json(result.body);
});

// --- Optional flight search (Amadeus Self-Service) -----------------------------

let cachedToken;
export function clearFlightToken() { cachedToken = undefined; }
export function validateFlightQuery(q) {
  if (!/^[A-Z]{3}$/.test(q.origin || '') || !/^[A-Z]{3}$/.test(q.destination || '')) return 'Use three-letter airport or city codes, such as JFK and LHR.';
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!validDate(q.departureDate)) return 'Enter a valid departure date.';
  if (q.returnDate && (!validDate(q.returnDate) || q.returnDate < q.departureDate)) return 'Enter a valid return date on or after departure.';
  if (!['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'].includes(q.travelClass)) return 'Select a valid cabin.';
  if (!/^[1-9]$/.test(String(q.adults || ''))) return 'Enter between 1 and 9 adults.';
  return '';
}
async function apiError(response, fallback) {
  let detail = '';
  try { const body = await response.json(); detail = body.error?.message || body.errors?.[0]?.detail || body.error_description || ''; } catch {}
  // Avoid relaying upstream details that might contain sensitive input or credentials.
  console.error(fallback, response.status, detail.slice(0, 300));
  return `${fallback} (provider returned ${response.status}). Check your credentials, account access and server logs.`;
}
app.get('/api/flights', async (req, res) => {
  if (!process.env.AMADEUS_CLIENT_ID || !process.env.AMADEUS_CLIENT_SECRET) return res.status(503).json({ error: 'Add Amadeus API credentials to .env to search flights.' });
  const q = req.query;
  const invalid = validateFlightQuery(q);
  if (invalid) return res.status(400).json({ error: invalid });
  const base = process.env.AMADEUS_ENV === 'production' ? 'https://api.amadeus.com' : 'https://test.api.amadeus.com';
  try {
    if (!cachedToken || cachedToken.base !== base || cachedToken.expires < Date.now()) {
      const tokenResponse = await fetch(`${base}/v1/security/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.AMADEUS_CLIENT_ID, client_secret: process.env.AMADEUS_CLIENT_SECRET }) });
      if (!tokenResponse.ok) return res.status(502).json({ error: await apiError(tokenResponse, 'Flight authentication failed') });
      const token = await tokenResponse.json();
      cachedToken = { value: token.access_token, expires: Date.now() + Math.max(0, token.expires_in - 60) * 1000, base };
    }
    const params = new URLSearchParams({ originLocationCode: q.origin, destinationLocationCode: q.destination, departureDate: q.departureDate, adults: String(q.adults), travelClass: q.travelClass, max: '10' });
    if (q.returnDate) params.set('returnDate', q.returnDate);
    const response = await fetch(`${base}/v2/shopping/flight-offers?${params}`, { headers: { Authorization: `Bearer ${cachedToken.value}` } });
    if (!response.ok) return res.status(502).json({ error: await apiError(response, 'Flight search failed') });
    const body = await response.json();
    res.json({ environment: process.env.AMADEUS_ENV === 'production' ? 'production' : 'test', offers: (body.data || []).map(o => ({ id: o.id, price: o.price?.grandTotal || o.price?.total, currency: o.price?.currency, itineraries: (o.itineraries || []).map(i => ({ duration: i.duration, segments: (i.segments || []).map(s => ({ from: s.departure?.iataCode, to: s.arrival?.iataCode, departure: s.departure?.at, arrival: s.arrival?.at, carrier: s.carrierCode, number: s.number })) })) })) });
  } catch (error) { console.error(error); res.status(502).json({ error: 'Could not reach the flight provider.' }); }
});

app.use((error, _req, res, _next) => { console.error(error.message); res.status(400).json({ error: error.message || 'Invalid request.' }); });
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Flightdesk running on port ${port}`));
}
export default app;
