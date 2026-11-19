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

app.get('/api/status', (_req, res) => res.json({ ai: Boolean(process.env.OPENAI_API_KEY), flights: Boolean(process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET), flightEnvironment: process.env.AMADEUS_ENV === 'production' ? 'production' : 'test' }));

async function apiError(response, fallback) {
  let detail = '';
  try { const body = await response.json(); detail = body.error?.message || body.errors?.[0]?.detail || body.error_description || ''; } catch {}
  // Avoid relaying upstream details that might contain sensitive input or credentials.
  console.error(fallback, response.status, detail.slice(0, 300));
  return `${fallback} (provider returned ${response.status}). Check your credentials, account access and server logs.`;
}
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'Add OPENAI_API_KEY to .env to enable transcription.' });
  if (!req.file) return res.status(400).json({ error: 'Audio is required.' });
  try {
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), 'audio.webm');
    form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
    form.append('language', 'en');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
    if (!response.ok) return res.status(502).json({ error: await apiError(response, 'Transcription failed') });
    const data = await response.json();
    res.json({ text: typeof data.text === 'string' ? data.text : '' });
  } catch (error) { console.error(error); res.status(502).json({ error: 'Could not reach the transcription provider.' }); }
});
app.post('/api/coach', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'Add OPENAI_API_KEY to .env to enable coaching.' });
  const transcript = typeof req.body.transcript === 'string' ? req.body.transcript.slice(-16000) : '';
  const context = typeof req.body.context === 'string' ? req.body.context.slice(0, 2000) : '';
  if (!transcript.trim()) return res.status(400).json({ error: 'A transcript is required.' });
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENAI_COACH_MODEL || 'gpt-4.1', messages: [{ role: 'system', content: coachPrompt }, { role: 'user', content: `Agent notes (unverified):\n${context}\n\nCall transcript:\n${transcript}` }], response_format: { type: 'json_object' }, max_completion_tokens: 250, temperature: 0.3 }) });
    if (!response.ok) return res.status(502).json({ error: await apiError(response, 'Coaching failed') });
    const body = await response.json();
    const result = JSON.parse(body.choices[0].message.content);
    res.json({ say: String(result.say || ''), insight: String(result.insight || ''), next: String(result.next || ''), technique: String(result.technique || '') });
  } catch (error) { console.error(error); res.status(502).json({ error: 'Could not generate coaching. Please try again.' }); }
});
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
