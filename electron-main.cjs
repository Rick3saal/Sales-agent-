const { app, BrowserWindow, ipcMain, safeStorage, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
let window, server, backendModule;
const keys = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET', 'OPENAI_TRANSCRIBE_MODEL', 'OPENAI_COACH_MODEL', 'GEMINI_MODEL'];
const configPath = () => path.join(app.getPath('userData'), 'credentials.enc');
function readConfig() {
  if (!fs.existsSync(configPath())) return {};
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The macOS Keychain is unavailable. Unlock it and try again.');
  return JSON.parse(safeStorage.decryptString(fs.readFileSync(configPath())));
}
function applyConfig(config) {
  for (const key of keys) { if (config[key]) process.env[key] = config[key]; else delete process.env[key]; }
  process.env.AI_PROVIDER = ['auto', 'openai', 'gemini'].includes(config.AI_PROVIDER) ? config.AI_PROVIDER : 'auto';
  process.env.AMADEUS_ENV = config.AMADEUS_ENV === 'production' ? 'production' : 'test';
  if (backendModule) backendModule.clearFlightToken();
}
function providerInfo() {
  const info = backendModule.resolveProviders();
  return { ai: info.providers.length > 0, aiProvider: info.mode, providers: info.configured, primary: info.providers[0] || null };
}
function flightInfo() {
  return { flights: Boolean(process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET), flightEnvironment: process.env.AMADEUS_ENV === 'production' ? 'production' : 'test' };
}
function requireWindow(event) { if (!window || event.sender.id !== window.webContents.id) throw new Error('Unauthorized request.'); }
app.whenReady().then(async () => {
  try { applyConfig(readConfig()); } catch (error) { console.error('Could not load encrypted settings:', error.message); }
  backendModule = await import('./server.js');
  server = backendModule.default.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    window = new BrowserWindow({ width: 1400, height: 950, minWidth: 820, minHeight: 650, title: 'Flightdesk', backgroundColor: '#f7f7fb', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const origin = `http://127.0.0.1:${port}`;
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${origin}/`)) event.preventDefault(); });
    window.webContents.setWindowOpenHandler(({ url }) => { if (url === `${origin}/README.html`) shell.openExternal(url); return { action: 'deny' }; });
    // Native picker is available only on supported macOS/Electron versions. Never select a source silently.
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: true });
    window.loadURL(`${origin}/`);
    window.on('closed', () => { window = null; });
  });
  ipcMain.handle('settings:status', event => { requireWindow(event); return { ...providerInfo(), ...flightInfo(), secureStorage: safeStorage.isEncryptionAvailable() }; });
  ipcMain.handle('settings:save', (event, values) => {
    requireWindow(event);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The macOS Keychain is unavailable. Unlock it and try again.');
    const config = readConfig();
    for (const key of keys) if (typeof values?.[key] === 'string' && values[key].trim()) config[key] = values[key].trim();
    config.AI_PROVIDER = ['auto', 'openai', 'gemini'].includes(values?.AI_PROVIDER) ? values.AI_PROVIDER : 'auto';
    config.AMADEUS_ENV = values?.AMADEUS_ENV === 'production' ? 'production' : 'test';
    const ciphertext = safeStorage.encryptString(JSON.stringify(config));
    fs.writeFileSync(configPath(), ciphertext, { mode: 0o600 });
    applyConfig(config);
    return { ...providerInfo(), ...flightInfo() };
  });
  ipcMain.handle('settings:clear', event => { requireWindow(event); if (fs.existsSync(configPath())) fs.unlinkSync(configPath()); applyConfig({}); return true; });
}).catch(error => { console.error(error); app.quit(); });
app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
