require('dotenv').config({ path: require('path').join(process.execPath, '..', '.env') });
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const OBSWebSocket = require('obs-websocket-js').default;

const app = express();
app.use(express.json());
app.use(express.static('public'));

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
  log: []
};

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
  const deviceId = process.env.JELLYFIN_DEVICE_ID;
  return sessions?.find(s => s.NowPlayingItem && s.DeviceId === deviceId) || null;
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

// Sound (placeholder — wire up to your audio player of choice)
app.post('/sound', async (req, res) => {
  const { sound } = req.body;
  addLog('sound', '!sound', `Play: ${sound}`);
  // TODO: implement sound playback (e.g. via afplay on Mac, or a sound board app)
  console.log(`[SOUND] Would play: ${sound}`);
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

// Run script (Mac: runs shell scripts from a scripts/ folder)
app.post('/run', async (req, res) => {
  const { script } = req.body;
  const { exec } = require('child_process');
  const scriptPath = `./scripts/${script}.sh`;
  addLog('system', '!run', `Running: ${scriptPath}`);
  exec(`bash ${scriptPath}`, (err, stdout, stderr) => {
    if (err) {
      addLog('system', '!run', err.message, false);
      return res.status(500).json({ error: err.message });
    }
    res.json({ ok: true, output: stdout });
  });
});

// Dashboard state endpoint
app.get('/api/state', (req, res) => {
  res.json({
    obs: state.obs,
    jellyfin: state.jellyfin,
    log: state.log
  });
});

// Dashboard WebSocket — send current state on connect
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    event: 'init',
    obs: state.obs,
    jellyfin: state.jellyfin,
    log: state.log
  }));
});

server.listen(PORT, () => {
  console.log(`Listener running on http://localhost:${PORT}`);
});
