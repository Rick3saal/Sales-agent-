const $ = id => document.getElementById(id);
let entries = [], streams = [], recorders = [], running = false, generation = 0, coachBusy = false, coachPending = false, coachTimer, recordingVersion = 0;
let lastStatus = {}, lastCoachAt = 0, coachAbort = null;
let transcribeQueue = [], transcribeActive = 0, backlogWarned = false;
const COACH_MIN_INTERVAL = 3000, MAX_TRANSCRIBE_IN_FLIGHT = 1, MAX_TRANSCRIBE_QUEUED = 4;
const desktop = window.flightdeskDesktop || null;
const show = (el, visible) => el.classList.toggle('hidden', !visible);
function sessionMessage(message) { $('session-message').textContent = message; show($('session-message'), !!message); }
async function request(url, options) { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Something went wrong.'); return data; }
async function status() {
  try {
    const data = await request('/api/status'); lastStatus = data;
    $('api-status').classList.toggle('connected', data.ai);
    const label = data.primary === 'gemini' ? 'GEMINI' : 'OPENAI';
    $('api-status').innerHTML = `<i></i> ${data.ai ? `${label}${data.provider === 'auto' ? ' · AUTO' : ''} connected` : 'AI setup required'}`;
    $('flight-status').textContent = data.flights ? `AMADEUS · ${data.flightEnvironment.toUpperCase()}` : 'AMADEUS · NOT CONNECTED';
  } catch { $('api-status').textContent = 'Connection unavailable'; }
}
async function devices() {
  try { const all = await navigator.mediaDevices.enumerateDevices(); const selected = $('device').value; $('device').replaceChildren(new Option('Default microphone', '')); all.filter(d => d.kind === 'audioinput').forEach((d, i) => $('device').add(new Option(d.label || `Audio input ${i + 1}`, d.deviceId))); $('device').value = selected; } catch {}
}
function scheduleCoach(delay) { clearTimeout(coachTimer); coachTimer = setTimeout(coach, delay); }
function addEntry(text, source, at = Date.now()) {
  if (!text.trim()) return;
  entries.push({ text: text.trim(), source, at }); entries.sort((a,b) => a.at - b.at);
  const container = $('transcript'); container.replaceChildren();
  for (const e of entries) { const row = document.createElement('div'); row.className = 'transcript-entry'; const icon = document.createElement('div'); icon.className = 'entry-avatar'; icon.textContent = e.source === 'Shared audio' ? '↗' : e.source === 'Manual note' ? '✎' : '◉'; const content = document.createElement('div'); content.className = 'entry-content'; const label = document.createElement('b'); label.textContent = `${e.source} · ${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; const p = document.createElement('div'); p.textContent = e.text; content.append(label,p); row.append(icon,content); container.append(row); }
  container.scrollTop = container.scrollHeight;
  scheduleCoach(1000);
}
async function coach() {
  if (!entries.length) return;
  if (coachBusy) { coachPending = true; return; }
  const wait = Math.max(0, COACH_MIN_INTERVAL - (Date.now() - lastCoachAt));
  if (wait) return scheduleCoach(wait);
  coachBusy = true; coachPending = false; const myGeneration = generation;
  lastCoachAt = Date.now(); coachAbort = new AbortController();
  $('coach-state').textContent = 'THINKING…'; show($('coach-error'), false);
  try {
    const transcript = entries.map(e => `${e.source}: ${e.text}`).join('\n');
    const result = await request('/api/coach', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({transcript}), signal: coachAbort.signal });
    if (myGeneration !== generation) return;
    $('suggestion').classList.remove('empty'); $('suggestion').querySelector('p').textContent = result.say || 'No suggestion returned.';
    $('insight').textContent = result.insight || 'Keep listening for customer needs.'; $('next').textContent = result.next || 'Continue the discovery.'; $('technique').textContent = `✦  ${result.technique || 'Discovery first'}`; $('coach-state').textContent = 'JUST UPDATED';
  } catch (e) { if (myGeneration === generation && e.name !== 'AbortError') { $('coach-error').textContent = e.message; show($('coach-error'), true); $('coach-state').textContent = 'SETUP OR RETRY NEEDED'; } }
  finally { coachBusy = false; coachAbort = null; if (coachPending) { coachPending = false; scheduleCoach(250); } }
}
// Serialise transcription chunks: a burst of 4-second clips is the main cause of 429s.
function enqueueTranscribe(blob, source, at, session, recording) {
  if (transcribeQueue.length >= MAX_TRANSCRIBE_QUEUED) {
    transcribeQueue.shift();
    if (!backlogWarned) { backlogWarned = true; sessionMessage('Transcription is falling behind; an older audio chunk was skipped. Try using one audio source.'); setTimeout(() => { backlogWarned = false; }, 8000); }
  }
  transcribeQueue.push({ blob, source, at, session, recording });
  pumpTranscribe();
}
async function pumpTranscribe() {
  if (transcribeActive >= MAX_TRANSCRIBE_IN_FLIGHT) return;
  const job = transcribeQueue.shift();
  if (!job) return;
  transcribeActive++;
  try {
    const form = new FormData(); form.append('audio', job.blob, 'audio.webm');
    const data = await request('/api/transcribe', { method:'POST', body:form });
    if (job.session === generation && job.recording === recordingVersion && data.text?.trim()) addEntry(data.text, job.source, job.at);
  } catch (e) { if (job.session === generation && job.recording === recordingVersion) sessionMessage(e.message); }
  finally { transcribeActive--; pumpTranscribe(); }
}
function startRecorder(stream, source, session, recording) {
  let recorder;
  try { recorder = new MediaRecorder(stream); } catch { sessionMessage('This browser cannot record the selected audio. Try Chrome on macOS.'); stop(); return; }
  recorders.push(recorder);
  let parts = [], chunkStart = Date.now(), timer;
  const begin = () => { if (!running || session !== generation || recording !== recordingVersion) return; parts = []; chunkStart = Date.now(); try { recorder.start(); timer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 4000); } catch (err) { sessionMessage(`Audio capture stopped: ${err.message}`); stop(); } };
  recorder.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
  recorder.onstop = () => {
    clearTimeout(timer); const blob = new Blob(parts, { type: recorder.mimeType || 'audio/webm' }); const at = chunkStart;
    if (blob.size > 1000) enqueueTranscribe(blob, source, at, session, recording);
    if (running && session === generation && recording === recordingVersion) begin();
  };
  recorder.onerror = () => { sessionMessage('Audio recording failed. Check permissions and try again.'); stop(); };
  begin();
}
function stop() {
  recordingVersion++; running = false;
  transcribeQueue = []; backlogWarned = false;
  clearTimeout(coachTimer); coachPending = false; if (coachAbort) coachAbort.abort();
  for (const recorder of recorders) if (recorder.state === 'recording') recorder.stop();
  recorders = []; for (const stream of streams) stream.getTracks().forEach(track => track.stop()); streams = [];
  show($('start'), true); show($('stop'), false); $('start').disabled = false;
  $('session-status').classList.remove('on'); $('session-status').innerHTML = '<i></i> NOT LIVE';
}
$('start').addEventListener('click', async () => {
  if (!$('consent').checked) return sessionMessage('Please confirm you have consent before starting.');
  if (!$('mic').checked && !$('share').checked) return sessionMessage('Select at least one audio source.');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return sessionMessage('Audio capture requires a supported browser and a secure context. Try Chrome on localhost or HTTPS.');
  $('start').disabled = true; sessionMessage(''); const acquired = []; const recording = ++recordingVersion;
  try {
    // Screen capture must be initiated directly from the click gesture.
    if ($('share').checked) { if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Screen audio sharing is not available in this browser.'); const shared = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:true }); acquired.push(shared); if (!shared.getAudioTracks().length) throw new Error('No shared audio was provided. Select a source with audio sharing enabled, or use a virtual audio input.'); }
    if ($('mic').checked) { const id = $('device').value; acquired.push(await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact:id }, echoCancellation:false, noiseSuppression:false, autoGainControl:false } : true })); }
    if (recording !== recordingVersion) { acquired.forEach(s => s.getTracks().forEach(t => t.stop())); return; }
    streams = acquired; running = true; show($('start'), false); show($('stop'), true); $('session-status').classList.add('on'); $('session-status').innerHTML = '<i></i> LISTENING';
    let index = 0; if ($('share').checked) { const shared = streams[index++]; shared.getTracks().forEach(t => t.addEventListener('ended', () => { if (running) { sessionMessage('Screen sharing ended. Session stopped.'); stop(); } }, {once:true})); startRecorder(new MediaStream(shared.getAudioTracks()), 'Shared audio', generation, recording); } if ($('mic').checked && running) startRecorder(streams[index], 'Microphone / input', generation, recording); devices();
  } catch (e) { acquired.forEach(s => s.getTracks().forEach(t => t.stop())); $('start').disabled = false; sessionMessage(`Could not start audio: ${e.message}`); }
});
$('stop').addEventListener('click', () => { stop(); sessionMessage('Listening stopped. Final transcript segments may still arrive.'); });
$('clear').addEventListener('click', () => { stop(); generation++; entries = []; transcribeQueue = []; clearTimeout(coachTimer); coachPending = false; $('transcript').innerHTML = '<div class="empty-transcript"><div class="wave">▁ ▃ ▆ ▃ ▅ ▂ ▁</div><b>Ready when you are</b><p>Start listening to see the conversation<br>unfold here in real time.</p></div>'; $('suggestion').classList.add('empty'); $('suggestion').querySelector('p').textContent = 'Your next best response will appear here once the conversation begins.'; $('insight').textContent = 'Listening for what matters most.'; $('next').textContent = 'A helpful next step will appear here.'; $('technique').textContent = '✦  Discovery first'; $('coach-state').textContent = 'WAITING FOR CONVERSATION'; show($('coach-error'), false); sessionMessage('Session cleared.'); });
function addManual() { const text = $('manual-text').value.trim(); if (text) { addEntry(text, 'Manual note'); $('manual-text').value = ''; } }
$('add-text').addEventListener('click', addManual); $('manual-text').addEventListener('keydown', e => { if (e.key === 'Enter') addManual(); }); $('refresh').addEventListener('click', coach);
$('flight-form').addEventListener('submit', async e => {
  e.preventDefault(); const button = e.currentTarget.querySelector('button'); button.disabled = true; button.textContent = 'Searching…'; const box = $('flight-results'); box.className = 'flight-results'; box.textContent = '';
  const params = new URLSearchParams({ origin:$('origin').value.trim().toUpperCase(), destination:$('destination').value.trim().toUpperCase(), departureDate:$('depart').value, travelClass:$('cabin').value, adults:$('adults').value }); if ($('return').value) params.set('returnDate',$('return').value);
  try { const data = await request(`/api/flights?${params}`); if (!data.offers.length) box.textContent = 'No offers found. Try different dates or airports.'; else { const note = document.createElement('p'); note.className = 'message'; note.textContent = data.environment === 'test' ? 'Test environment: offers may be synthetic and are not bookable.' : 'Indicative offers. Confirm current price, baggage, fare rules and availability before quoting.'; box.append(note); for (const offer of data.offers) { const row = document.createElement('div'); row.className = 'flight-result'; const details = document.createElement('div'); details.textContent = offer.itineraries.map((i, n) => `${n ? 'Return' : 'Outbound'}: ${i.segments.map(s => `${s.from} → ${s.to} · ${s.carrier}${s.number} · ${s.departure?.replace('T', ' ')}`).join(' / ')}`).join(' | '); const price = document.createElement('b'); price.textContent = `${offer.currency || ''} ${offer.price || 'Price unavailable'}`; row.append(details, price); box.append(row); } } }
  catch(err) { box.textContent = err.message; box.className = 'flight-results error'; }
  finally { button.disabled = false; button.textContent = '⌕  Search flights'; }
});
status(); devices();
show($('settings-open'), true);
async function openSettings() {
  show($('settings-error'), false); show($('settings-test-result'), false);
  try {
    const info = desktop ? await desktop.settingsStatus() : lastStatus;
    $('openai-saved').textContent = info.providers?.openai ? '· SAVED' : '';
    $('gemini-saved').textContent = info.providers?.gemini ? '· SAVED' : '';
    $('amadeus-saved').textContent = info.flights ? '· SAVED' : '';
    $('settings-provider').value = info.aiProvider || info.provider || 'auto';
    $('settings-environment').value = info.flightEnvironment || 'test';
    show($('settings-browser-note'), !desktop);
    $('settings-clear').disabled = !desktop; $('settings-clear').title = desktop ? '' : 'Available in the Mac desktop app';
    $('settings-form').querySelector('button[type="submit"]').textContent = desktop ? 'Save settings' : 'Close';
    $('settings-dialog').showModal();
  } catch (e) { sessionMessage(`Could not open settings: ${e.message}`); }
}
$('settings-open').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
function renderTestResult(results) {
  const box = $('settings-test-result'); box.textContent = ''; box.className = 'test-result'; show(box, true);
  for (const r of (results || [])) {
    const line = document.createElement('div'); line.className = r.ok ? 'ok' : 'fail';
    const name = r.provider === 'openai' ? 'OpenAI' : r.provider === 'gemini' ? 'Gemini' : 'Setup';
    line.textContent = r.ok ? `✓ ${name}: key accepted${r.detail ? ` · ${r.detail}` : ''} (${r.latencyMs} ms)` : `✕ ${name}: ${r.message || r.code}`;
    box.append(line);
  }
}
$('settings-test').addEventListener('click', async () => {
  const button = $('settings-test'); button.disabled = true; button.textContent = 'Testing…';
  const box = $('settings-test-result'); box.textContent = 'Contacting providers…'; box.className = 'test-result'; show(box, true);
  try { const data = await request('/api/test'); renderTestResult(data.results); }
  catch (e) { box.textContent = e.message; }
  finally { button.disabled = false; button.textContent = '⚡  Test connection'; }
});
$('settings-form').addEventListener('submit', async e => {
  e.preventDefault(); show($('settings-error'), false);
  if (!desktop) { $('settings-dialog').close(); return; }
  try {
    await desktop.saveSettings({ AI_PROVIDER:$('settings-provider').value, OPENAI_API_KEY:$('settings-openai').value, GEMINI_API_KEY:$('settings-gemini').value, OPENAI_TRANSCRIBE_MODEL:$('settings-transcribe-model').value, OPENAI_COACH_MODEL:$('settings-coach-model').value, GEMINI_MODEL:$('settings-gemini-model').value, AMADEUS_CLIENT_ID:$('settings-amadeus-id').value, AMADEUS_CLIENT_SECRET:$('settings-amadeus-secret').value, AMADEUS_ENV:$('settings-environment').value });
    for (const id of ['settings-openai','settings-gemini','settings-amadeus-id','settings-amadeus-secret','settings-transcribe-model','settings-coach-model','settings-gemini-model']) $(id).value = '';
    $('settings-dialog').close(); await status();
  } catch (error) { $('settings-error').textContent = error.message; show($('settings-error'), true); }
});
$('settings-clear').addEventListener('click', async () => {
  if (!confirm('Remove all saved API credentials from this Mac?')) return;
  try { await desktop.clearSettings(); for (const id of ['settings-openai','settings-gemini','settings-amadeus-id','settings-amadeus-secret','settings-transcribe-model','settings-coach-model','settings-gemini-model']) $(id).value = ''; $('settings-dialog').close(); await status(); } catch (error) { $('settings-error').textContent = error.message; show($('settings-error'), true); }
});
if (desktop) desktop.settingsStatus().then(info => { if (!info.ai) openSettings(); }).catch(() => {});
