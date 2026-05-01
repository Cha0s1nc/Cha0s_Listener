const dotenvPath = process.env.DOTENV_CONFIG_PATH || require('path').join(__dirname, '.env');
require('dotenv').config({ path: dotenvPath });
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const OBSWebSocket = require('obs-websocket-js').default;

const app = express();
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

// Serve sounds folder from next to the executable (or project root in dev)
const SOUNDS_DIR = process.env.SOUNDS_DIR ||
  (require('path').join(process.pkg ? require('path').dirname(process.execPath) : __dirname, 'sounds'));
app.use('/sounds', express.static(SOUNDS_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.LISTENER_PORT || 3000;
const JELLYFIN_URL = process.env.JELLYFIN_URL;
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;
const OBS_HOST = process.env.OBS_HOST || 'localhost';
const OBS_PORT = process.env.OBS_PORT || 4455;
const OBS_PASSWORD = process.env.OBS_PASSWORD;

// --- State ---
const state = {
  obs: { connected: false, reconnecting: false },
  jellyfin: { connected: false, lastChecked: null },
  bot: { connected: false, lastSeen: null },
  log: []
};

// Bot timeout — mark as disconnected if no ping for 45s
setInterval(() => {
  if (state.bot.connected && state.bot.lastSeen) {
    const elapsed = Date.now() - new Date(state.bot.lastSeen).getTime();
    if (elapsed > 45000) {
      state.bot.connected = false;
      broadcast({ event: 'status', service: 'bot', connected: false });
      addLog('system', 'bot', 'Bot stopped pinging — disconnected', false);
    }
  }
}, 15000);

// --- Dashboard WebSocket broadcast ---
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function addLog(type, command, detail, ok = true) {
  const entry = {
    id: Date.now(),
    time: new Date().toISOString(),
    type,
    command,
    detail,
    ok
  };
  state.log.unshift(entry);
  if (state.log.length > 100) state.log.pop();
  broadcast({ event: 'log', entry });
}

// --- OBS ---
const obs = new OBSWebSocket();

async function connectOBS() {
  if (state.obs.connected || state.obs.reconnecting) return;
  state.obs.reconnecting = true;
  try {
    await obs.connect(`ws://${OBS_HOST}:${OBS_PORT}`, OBS_PASSWORD);
    state.obs.connected = true;
    state.obs.reconnecting = false;
    console.log('OBS connected');
    broadcast({ event: 'status', service: 'obs', connected: true });
    addLog('obs', 'connect', 'OBS WebSocket connected');
  } catch (err) {
    state.obs.reconnecting = false;
    state.obs.connected = false;
    console.log(`OBS connection failed: ${err.message} — retrying in 10s`);
    broadcast({ event: 'status', service: 'obs', connected: false });
    setTimeout(connectOBS, 10000);
  }
}

obs.on('ConnectionClosed', () => {
  state.obs.connected = false;
  broadcast({ event: 'status', service: 'obs', connected: false });
  addLog('obs', 'disconnect', 'OBS connection lost — reconnecting...', false);
  setTimeout(connectOBS, 10000);
});

connectOBS();

// --- Jellyfin helpers ---
async function jellyfinRequest(path, method = 'GET', body = null) {
  const url = `${JELLYFIN_URL}${path}`;
  const opts = {
    method,
    headers: {
      'X-Emby-Token': JELLYFIN_API_KEY,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getActiveSession() {
  const sessions = await jellyfinRequest('/Sessions');
  return sessions?.find(s => s.NowPlayingItem) || null;
}

async function checkJellyfinConnection() {
  try {
    await jellyfinRequest('/System/Info/Public');
    if (!state.jellyfin.connected) {
      state.jellyfin.connected = true;
      broadcast({ event: 'status', service: 'jellyfin', connected: true });
      addLog('jellyfin', 'connect', 'Jellyfin reachable');
    }
    state.jellyfin.lastChecked = new Date().toISOString();
  } catch {
    if (state.jellyfin.connected) {
      state.jellyfin.connected = false;
      broadcast({ event: 'status', service: 'jellyfin', connected: false });
      addLog('jellyfin', 'disconnect', 'Jellyfin unreachable', false);
    }
  }
}

checkJellyfinConnection();
setInterval(checkJellyfinConnection, 30000);

// --- Routes ---

// Song info
app.post('/media', async (req, res) => {
  const { action } = req.body;

  if (action === 'song') {
    try {
      const session = await getActiveSession();
      if (!session) {
        addLog('jellyfin', '!song', 'Nothing playing');
        return res.json({ nothing: true });
      }
      const item = session.NowPlayingItem;
      const artist = item.Artists?.[0] || item.AlbumArtist || 'Unknown Artist';
      const title = item.Name || 'Unknown Title';
      const song = `${artist} — ${title}`;
      addLog('jellyfin', '!song', song);
      return res.json({ song });
    } catch (err) {
      addLog('jellyfin', '!song', err.message, false);
      return res.status(500).json({ error: err.message });
    }
  }

  // Playback controls
  const commandMap = {
    playpause: 'PlayPause',
    next: 'NextTrack',
    prev: 'PreviousTrack'
  };

  const command = commandMap[action];
  if (!command) return res.status(400).json({ error: `Unknown action: ${action}` });

  try {
    const session = await getActiveSession();
    if (!session) {
      addLog('jellyfin', `!${action}`, 'No active session', false);
      return res.status(404).json({ error: 'No active Jellyfin session' });
    }
    await jellyfinRequest(`/Sessions/${session.Id}/Playing/${command}`, 'POST');
    addLog('jellyfin', `!${action}`, `Sent ${command} to session ${session.Id}`);
    return res.json({ ok: true });
  } catch (err) {
    addLog('jellyfin', `!${action}`, err.message, false);
    return res.status(500).json({ error: err.message });
  }
});

// Sound — tells the dashboard to play via Web Audio API
app.post('/sound', async (req, res) => {
  const { sound } = req.body;
  const fs = require('fs');
  const path = require('path');

  // If it's a URL, play it directly
  if (sound.startsWith('http://') || sound.startsWith('https://')) {
    broadcast({ event: 'play_sound', url: sound });
    addLog('sound', '!sound', `Playing URL: ${sound}`);
    return res.json({ ok: true });
  }

  // Otherwise look for a local file
  const extensions = ['mp3', 'wav', 'ogg', 'flac'];
  const found = extensions.find(ext =>
    fs.existsSync(path.join(SOUNDS_DIR, `${sound}.${ext}`))
  );

  if (!found) {
    addLog('sound', '!sound', `File not found: ${sound}`, false);
    return res.status(404).json({ error: `Sound "${sound}" not found in sounds folder` });
  }

  const url = `/sounds/${sound}.${found}`;
  broadcast({ event: 'play_sound', url });
  addLog('sound', '!sound', `Playing: ${sound}.${found}`);
  res.json({ ok: true });
});

// OBS scene switch
app.post('/scene', async (req, res) => {
  const { scene } = req.body;
  if (!state.obs.connected) {
    addLog('obs', '!scene', 'OBS not connected', false);
    return res.status(503).json({ error: 'OBS not connected' });
  }
  try {
    await obs.call('SetCurrentProgramScene', { sceneName: scene });
    addLog('obs', '!scene', `Switched to: ${scene}`);
    res.json({ ok: true });
  } catch (err) {
    addLog('obs', '!scene', err.message, false);
    res.status(500).json({ error: err.message });
  }
});

// OBS source toggle
app.post('/source', async (req, res) => {
  const { source, visible } = req.body;
  if (!state.obs.connected) {
    addLog('obs', '!source', 'OBS not connected', false);
    return res.status(503).json({ error: 'OBS not connected' });
  }
  try {
    // Find which scene contains this source
    const { scenes } = await obs.call('GetSceneList');
    let found = false;
    for (const scene of scenes) {
      const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene.sceneName });
      const item = sceneItems.find(i => i.sourceName === source);
      if (item) {
        await obs.call('SetSceneItemEnabled', {
          sceneName: scene.sceneName,
          sceneItemId: item.sceneItemId,
          sceneItemEnabled: visible
        });
        found = true;
        addLog('obs', '!source', `${source} → ${visible ? 'on' : 'off'}`);
        break;
      }
    }
    if (!found) {
      addLog('obs', '!source', `Source not found: ${source}`, false);
      return res.status(404).json({ error: `Source "${source}" not found` });
    }
    res.json({ ok: true });
  } catch (err) {
    addLog('obs', '!source', err.message, false);
    res.status(500).json({ error: err.message });
  }
});

// OBS recording control
app.post('/recording', async (req, res) => {
  const { action } = req.body;
  if (!state.obs.connected) {
    addLog('obs', `!record`, 'OBS not connected', false);
    return res.status(503).json({ error: 'OBS not connected' });
  }
  try {
    if (action === 'start') {
      await obs.call('StartRecord');
      addLog('obs', '!record', 'Recording started');
    } else if (action === 'stop') {
      await obs.call('StopRecord');
      addLog('obs', '!record', 'Recording stopped');
    } else {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    res.json({ ok: true });
  } catch (err) {
    addLog('obs', '!record', err.message, false);
    res.status(500).json({ error: err.message });
  }
});

// Killswitch — stops stream and recording
app.post('/killswitch', async (req, res) => {
  if (!state.obs.connected) {
    addLog('obs', '!killswitch', 'OBS not connected', false);
    return res.status(503).json({ error: 'OBS not connected' });
  }
  try {
    await obs.call('StopStream');
    addLog('obs', '!killswitch', 'Stream stopped');
    try {
      await obs.call('StopRecord');
      addLog('obs', '!killswitch', 'Recording stopped');
    } catch {
      // Recording may not have been active, that's fine
    }
    res.json({ ok: true });
  } catch (err) {
    addLog('obs', '!killswitch', err.message, false);
    res.status(500).json({ error: err.message });
  }
});

// Run script — fetches from URL and executes based on file extension and platform
app.post('/run', async (req, res) => {
  const { script } = req.body;
  const { exec } = require('child_process');
  const os = require('os');
  const platform = os.platform();

  // Must be a URL
  if (!script.startsWith('http://') && !script.startsWith('https://')) {
    addLog('system', '!run', `Invalid script URL: ${script}`, false);
    return res.status(400).json({ error: 'Script must be a URL' });
  }

  // Check allowlist
  const allowlist = (process.env.SCRIPT_ALLOWLIST || '').split(',').map(d => d.trim()).filter(Boolean);
  if (allowlist.length > 0) {
    const scriptHost = new URL(script).hostname;
    const allowed = allowlist.some(domain => scriptHost === domain || scriptHost.endsWith(`.${domain}`));
    if (!allowed) {
      addLog('system', '!run', `Blocked — domain not in allowlist: ${scriptHost}`, false);
      return res.status(403).json({ error: 'Script failed!' });
    }
  }

  // Fetch script content
  let scriptContent;
  try {
    const fetchRes = await fetch(script);
    if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
    scriptContent = await fetchRes.text();
  } catch (err) {
    addLog('system', '!run', `Could not fetch script: ${err.message}`, false);
    return res.status(500).json({ error: 'Script failed!' });
  }

  // Determine script type from URL extension
  const ext = script.split('?')[0].split('.').pop().toLowerCase();

  // Check platform compatibility
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const isLinux = platform === 'linux';

  let command;
  const tmpFile = require('path').join(require('os').tmpdir(), `cha0s_script_${Date.now()}.${ext}`);
  require('fs').writeFileSync(tmpFile, scriptContent);

  if (ext === 'sh' && (isMac || isLinux)) {
    command = `bash "${tmpFile}"`;
  } else if (ext === 'sh' && isWindows) {
    // Try bash via Git Bash or WSL
    const hasBash = await new Promise(resolve => exec('bash --version', err => resolve(!err)));
    if (!hasBash) {
      require('fs').unlinkSync(tmpFile);
      addLog('system', '!run', `Script failed! .sh not supported on Windows without bash`, false);
      return res.status(500).json({ error: 'Script failed!' });
    }
    command = `bash "${tmpFile}"`;
  } else if (ext === 'ps1' && isWindows) {
    command = `powershell -ExecutionPolicy Bypass -File "${tmpFile}"`;
  } else if (ext === 'ps1' && !isWindows) {
    require('fs').unlinkSync(tmpFile);
    addLog('system', '!run', `Script failed! .ps1 not supported on ${platform}`, false);
    return res.status(500).json({ error: 'Script failed!' });
  } else if (ext === 'bat' && isWindows) {
    command = `cmd /c "${tmpFile}"`;
  } else if (ext === 'bat' && !isWindows) {
    require('fs').unlinkSync(tmpFile);
    addLog('system', '!run', `Script failed! .bat not supported on ${platform}`, false);
    return res.status(500).json({ error: 'Script failed!' });
  } else {
    require('fs').unlinkSync(tmpFile);
    addLog('system', '!run', `Script failed! Unknown extension: .${ext}`, false);
    return res.status(400).json({ error: 'Script failed!' });
  }

  addLog('system', '!run', `Running ${ext.toUpperCase()} script from URL`);
  exec(command, (err, stdout, stderr) => {
    try { require('fs').unlinkSync(tmpFile); } catch {}
    if (err) {
      addLog('system', '!run', `Script failed! ${err.message}`, false);
      return res.status(500).json({ error: 'Script failed!' });
    }
    addLog('system', '!run', `Script completed successfully`);
    res.json({ ok: true, output: stdout });
  });
});

// Bot ping endpoint
app.post('/ping', (req, res) => {
  const wasConnected = state.bot.connected;
  state.bot.connected = true;
  state.bot.lastSeen = new Date().toISOString();
  if (!wasConnected) {
    broadcast({ event: 'status', service: 'bot', connected: true });
    addLog('system', 'bot', 'Bot connected');
  }
  res.json({ ok: true });
});

// Dashboard state endpoint
app.get('/api/state', (req, res) => {
  res.json({
    obs: state.obs,
    jellyfin: state.jellyfin,
    bot: state.bot,
    log: state.log
  });
});

// Settings — update running config from dashboard
app.post('/settings', (req, res) => {
  const allowed = ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'JELLYFIN_DEVICE_ID', 'OBS_HOST', 'OBS_PORT', 'OBS_PASSWORD', 'LISTENER_PORT', 'SCRIPT_ALLOWLIST'];
  const updated = [];
  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) {
      process.env[key] = value;
      updated.push(key);
    }
  }
  addLog('system', 'settings', `Updated: ${updated.join(', ')}`);
  // Reconnect OBS if its settings changed
  if (updated.some(k => k.startsWith('OBS_'))) {
    state.obs.connected = false;
    state.obs.reconnecting = false;
    obs.disconnect().catch(() => {});
    setTimeout(connectOBS, 500);
  }
  // Recheck Jellyfin if its settings changed
  if (updated.some(k => k.startsWith('JELLYFIN_'))) {
    state.jellyfin.connected = false;
    checkJellyfinConnection();
  }
  res.json({ ok: true, updated });
});

// Dashboard WebSocket — send current state on connect
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    event: 'init',
    obs: state.obs,
    jellyfin: state.jellyfin,
    bot: state.bot,
    log: state.log
  }));
});

server.listen(PORT, () => {
  console.log(`Listener running on http://localhost:${PORT}`);
});