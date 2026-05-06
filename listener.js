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
  twitch: { connected: false },
  log: [],
  // Song request queue: [{ id, user, query, resolvedItem, status: 'pending'|'approved'|'skipped' }]
  queue: [],
  // Download wishlist: [{ id, user, query, addedAt }]
  wishlist: [],
  // Redeem actions map: { [redeemTitle]: { type: 'script'|'sound'|'scene'|'source', ...params } }
  redeemActions: {}
};

// Load redeem actions from env on startup
try {
  if (process.env.REDEEM_ACTIONS) {
    state.redeemActions = JSON.parse(process.env.REDEEM_ACTIONS);
  }
} catch { console.log('Could not parse REDEEM_ACTIONS'); }

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
let jellyfinToken = null;
let jellyfinUserId = null;

async function authenticateJellyfin() {
  const username = process.env.JELLYFIN_USERNAME;
  const password = process.env.JELLYFIN_PASSWORD;
  const apiKey = process.env.JELLYFIN_API_KEY;

  if (username && password) {
    try {
      const res = await fetch(`${JELLYFIN_URL}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Emby-Authorization': 'MediaBrowser Client="Cha0s Listener", Device="Cha0s", DeviceId="cha0s_listener", Version="1.0"'
        },
        body: JSON.stringify({ Username: username, Pw: password })
      });
      if (res.ok) {
        const data = await res.json();
        jellyfinToken = data.AccessToken;
        jellyfinUserId = data.User?.Id || null;
        console.log('Jellyfin authenticated via username/password');
        return;
      }
      console.log('Jellyfin username/password auth failed, falling back to API key');
    } catch (err) {
      console.log(`Jellyfin auth error: ${err.message}, falling back to API key`);
    }
  }

  if (apiKey) {
    jellyfinToken = apiKey;
    // Fetch user ID from API key
    try {
      const res = await fetch(`${JELLYFIN_URL}/Users/Me`, {
        headers: { 'X-Emby-Token': apiKey }
      });
      if (res.ok) {
        const data = await res.json();
        jellyfinUserId = data.Id || null;
      }
    } catch {}
    console.log('Jellyfin using API key');
  } else {
    console.log('No Jellyfin credentials configured');
  }
}

async function jellyfinRequest(path, method = 'GET', body = null) {
  if (!jellyfinToken) await authenticateJellyfin();
  const url = `${JELLYFIN_URL}${path}`;
  const opts = {
    method,
    headers: {
      'X-Emby-Token': jellyfinToken,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 401) {
    jellyfinToken = null;
    await authenticateJellyfin();
    opts.headers['X-Emby-Token'] = jellyfinToken;
    const retry = await fetch(url, opts);
    if (!retry.ok) throw new Error(`Jellyfin HTTP ${retry.status}`);
    const retryText = await retry.text();
    return retryText ? JSON.parse(retryText) : null;
  }
  if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getActiveSession() {
  const sessions = await jellyfinRequest('/Sessions');
  const deviceId = process.env.JELLYFIN_DEVICE_ID;
  const username = process.env.JELLYFIN_USERNAME;

  return sessions?.find(s => {
    if (!s.NowPlayingItem) return false;
    if (username && s.UserName?.toLowerCase() !== username.toLowerCase()) return false;
    if (deviceId && s.DeviceId !== deviceId) return false;
    return true;
  }) || null;
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

// --- OS Media Keys (fallback mode) ---
// Uses child_process to send media key events cross-platform
function sendOSMediaKey(action) {
  const { exec } = require('child_process');
  const os = require('os');
  const platform = os.platform();

  const commands = {
    playpause: {
      darwin: `osascript -e 'tell application "System Events" to key code 100'`,
      win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]179)"`,
      linux: `xdotool key XF86AudioPlay`
    },
    next: {
      darwin: `osascript -e 'tell application "System Events" to key code 101'`,
      win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]176)"`,
      linux: `xdotool key XF86AudioNext`
    },
    prev: {
      darwin: `osascript -e 'tell application "System Events" to key code 98'`,
      win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]177)"`,
      linux: `xdotool key XF86AudioPrev`
    }
  };

  const cmd = commands[action]?.[platform];
  if (!cmd) throw new Error(`OS media key not supported for ${action} on ${platform}`);
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => err ? reject(err) : resolve());
  });
}

// --- Twitch EventSub WebSocket ---
let twitchWs = null;
let twitchReconnectTimer = null;
let twitchSessionId = null;

async function getTwitchUserId(channelName, token) {
  // Strip 'oauth:' prefix if present
  const bearerToken = token.replace(/^oauth:/i, '');
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${channelName}`, {
    headers: {
      'Authorization': `Bearer ${bearerToken}`,
      'Client-Id': process.env.TWITCH_CLIENT_ID || ''
    }
  });
  if (!res.ok) throw new Error(`Twitch user lookup failed: ${res.status}`);
  const data = await res.json();
  return data.data?.[0]?.id || null;
}

async function subscribeToRedeems(sessionId) {
  const channel = process.env.TWITCH_CHANNEL;
  const token = (process.env.TWITCH_OAUTH || '').replace(/^oauth:/i, '');
  const clientId = process.env.TWITCH_CLIENT_ID || '';
  if (!channel || !token || !clientId) {
    console.log('Twitch EventSub: missing TWITCH_CHANNEL, TWITCH_OAUTH, or TWITCH_CLIENT_ID — skipping redeem subscription');
    return;
  }
  try {
    const broadcasterId = await getTwitchUserId(channel, token);
    if (!broadcasterId) throw new Error('Could not resolve broadcaster ID');

    const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        condition: { broadcaster_user_id: broadcasterId },
        transport: { method: 'websocket', session_id: sessionId }
      })
    });
    if (res.ok) {
      addLog('system', 'twitch', 'Subscribed to channel point redeems');
    } else {
      const err = await res.json();
      addLog('system', 'twitch', `Redeem subscription failed: ${err.message || res.status}`, false);
    }
  } catch (err) {
    addLog('system', 'twitch', `Redeem subscription error: ${err.message}`, false);
  }
}

async function subscribeToChatCommands(sessionId) {
  // Subscribe to chat messages for !sr song request command
  const channel = process.env.TWITCH_CHANNEL;
  const token = (process.env.TWITCH_OAUTH || '').replace(/^oauth:/i, '');
  const clientId = process.env.TWITCH_CLIENT_ID || '';
  if (!channel || !token || !clientId) return;

  try {
    const broadcasterId = await getTwitchUserId(channel, token);
    if (!broadcasterId) return;
    const userId = await getTwitchUserId(process.env.TWITCH_USERNAME || channel, token);

    await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: broadcasterId, user_id: userId || broadcasterId },
        transport: { method: 'websocket', session_id: sessionId }
      })
    });
  } catch (err) {
    console.log('Chat subscription error:', err.message);
  }
}

function connectTwitchEventSub() {
  if (twitchReconnectTimer) { clearTimeout(twitchReconnectTimer); twitchReconnectTimer = null; }
  const token = process.env.TWITCH_OAUTH;
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!token || !clientId) {
    console.log('Twitch EventSub: TWITCH_OAUTH or TWITCH_CLIENT_ID not set, skipping');
    return;
  }

  twitchWs = new WebSocket('wss://eventsub.wss.twitch.tv/ws');

  twitchWs.on('open', () => {
    console.log('Twitch EventSub WebSocket open');
  });

  twitchWs.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const type = msg.metadata?.message_type;

    if (type === 'session_welcome') {
      twitchSessionId = msg.payload?.session?.id;
      state.twitch.connected = true;
      broadcast({ event: 'status', service: 'twitch', connected: true });
      addLog('system', 'twitch', 'EventSub connected');

      // Subscribe based on mode
      const srMode = process.env.SONG_REQUEST_MODE || 'chat';
      if (srMode === 'channel_points') {
        await subscribeToRedeems(twitchSessionId);
      }
      // Always subscribe to chat for !sr command (when not channel-points-only)
      await subscribeToChatCommands(twitchSessionId);
      // Also subscribe to redeems if redeem actions are configured
      if (Object.keys(state.redeemActions).length > 0 && srMode !== 'channel_points') {
        await subscribeToRedeems(twitchSessionId);
      }
    }

    if (type === 'session_keepalive') return;

    if (type === 'session_reconnect') {
      const url = msg.payload?.session?.reconnect_url;
      if (url) {
        twitchWs.close();
        twitchWs = new WebSocket(url);
      }
      return;
    }

    if (type === 'notification') {
      const subType = msg.metadata?.subscription_type;
      const event = msg.payload?.event;

      // Channel point redeem
      if (subType === 'channel.channel_points_custom_reward_redemption.add') {
        const redeemTitle = event?.reward?.title;
        const user = event?.user_name || 'unknown';
        const input = event?.user_input || '';
        addLog('system', `redeem`, `${user} redeemed: ${redeemTitle}${input ? ` — "${input}"` : ''}`);
        await handleRedeem(redeemTitle, user, input);
      }

      // Chat message — check for !sr command
      if (subType === 'channel.chat.message') {
        const user = event?.chatter_user_name || 'unknown';
        const text = event?.message?.text || '';
        if (text.toLowerCase().startsWith('!sr ')) {
          const query = text.slice(4).trim();
          if (query) await handleSongRequest(user, query, 'chat');
        }
      }
    }
  });

  twitchWs.on('close', () => {
    state.twitch.connected = false;
    broadcast({ event: 'status', service: 'twitch', connected: false });
    addLog('system', 'twitch', 'EventSub disconnected — reconnecting in 15s', false);
    twitchReconnectTimer = setTimeout(connectTwitchEventSub, 15000);
  });

  twitchWs.on('error', (err) => {
    console.log('Twitch EventSub error:', err.message);
  });
}

// Start Twitch EventSub if credentials are available
if (process.env.TWITCH_OAUTH && process.env.TWITCH_CLIENT_ID) {
  connectTwitchEventSub();
}

// --- Redeem action handler ---
async function handleRedeem(redeemTitle, user, input) {
  const action = state.redeemActions[redeemTitle];
  if (!action) {
    // Check if it's a song request redeem
    const srMode = process.env.SONG_REQUEST_MODE || 'chat';
    const srRedeemName = process.env.SONG_REQUEST_REDEEM_NAME || '';
    if (srMode === 'channel_points' && srRedeemName && redeemTitle === srRedeemName) {
      await handleSongRequest(user, input, 'redeem');
    }
    return;
  }

  try {
    if (action.type === 'script') {
      // Trigger existing /run logic
      const res = await fetch(`http://localhost:${PORT}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: action.script })
      });
      const data = await res.json();
      if (!data.ok) addLog('system', `redeem:${redeemTitle}`, `Script failed`, false);
    } else if (action.type === 'sound') {
      broadcast({ event: 'play_sound', url: action.sound });
      addLog('sound', `redeem:${redeemTitle}`, `Playing: ${action.sound}`);
    } else if (action.type === 'scene') {
      if (state.obs.connected) {
        await obs.call('SetCurrentProgramScene', { sceneName: action.scene });
        addLog('obs', `redeem:${redeemTitle}`, `Scene → ${action.scene}`);
      }
    } else if (action.type === 'source') {
      if (state.obs.connected) {
        const { scenes } = await obs.call('GetSceneList');
        for (const scene of scenes) {
          const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene.sceneName });
          const item = sceneItems.find(i => i.sourceName === action.source);
          if (item) {
            await obs.call('SetSceneItemEnabled', {
              sceneName: scene.sceneName,
              sceneItemId: item.sceneItemId,
              sceneItemEnabled: action.visible !== false
            });
            addLog('obs', `redeem:${redeemTitle}`, `Source ${action.source} → ${action.visible !== false ? 'on' : 'off'}`);
            break;
          }
        }
      }
    }
  } catch (err) {
    addLog('system', `redeem:${redeemTitle}`, `Action failed: ${err.message}`, false);
  }
}

// --- Song request handler ---
async function handleSongRequest(user, query, source) {
  if (!query) return;

  addLog('jellyfin', `!sr`, `${user} requested: ${query}`);

  // Try to find it in Jellyfin
  let resolvedItem = null;
  try {
    if (jellyfinToken && JELLYFIN_URL) {
      const uid = jellyfinUserId;
      const searchPath = uid
        ? `/Users/${uid}/Items?searchTerm=${encodeURIComponent(query)}&IncludeItemTypes=Audio&Recursive=true&Limit=1&Fields=Id,Name,Artists,Album`
        : `/Items?searchTerm=${encodeURIComponent(query)}&IncludeItemTypes=Audio&Recursive=true&Limit=1&Fields=Id,Name,Artists,Album`;
      const result = await jellyfinRequest(searchPath);
      if (result?.Items?.length > 0) {
        const item = result.Items[0];
        resolvedItem = {
          id: item.Id,
          name: item.Name,
          artist: item.Artists?.[0] || item.AlbumArtist || '',
          album: item.Album || ''
        };
      }
    }
  } catch (err) {
    console.log('Song search error:', err.message);
  }

  const entry = {
    id: `req_${Date.now()}`,
    user,
    query,
    source,
    resolvedItem,
    status: 'pending',
    addedAt: new Date().toISOString()
  };

  if (!resolvedItem) {
    // Add to wishlist instead of queue
    const wishlistEntry = {
      id: `wish_${Date.now()}`,
      user,
      query,
      addedAt: new Date().toISOString()
    };
    state.wishlist.unshift(wishlistEntry);
    if (state.wishlist.length > 200) state.wishlist.pop();
    broadcast({ event: 'wishlist_add', entry: wishlistEntry });
    addLog('jellyfin', `!sr`, `"${query}" not found — added to wishlist`, false);
  } else {
    state.queue.push(entry);
    broadcast({ event: 'queue_add', entry });
    addLog('jellyfin', `!sr`, `Queued: ${resolvedItem.artist} — ${resolvedItem.name}`);
  }
}

// --- Routes ---

// Song info
app.post('/media', async (req, res) => {
  const { action } = req.body;
  const mediaMode = process.env.MEDIA_CONTROL_MODE || 'jellyfin';

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

  const commandMap = {
    playpause: 'PlayPause',
    next: 'NextTrack',
    prev: 'PreviousTrack'
  };

  const command = commandMap[action];
  if (!command) return res.status(400).json({ error: `Unknown action: ${action}` });

  // OS media key mode
  if (mediaMode === 'os') {
    try {
      await sendOSMediaKey(action);
      addLog('system', `!${action}`, `OS media key: ${action}`);
      return res.json({ ok: true });
    } catch (err) {
      addLog('system', `!${action}`, err.message, false);
      return res.status(500).json({ error: err.message });
    }
  }

  // Jellyfin mode (default)
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

  if (sound.startsWith('http://') || sound.startsWith('https://')) {
    broadcast({ event: 'play_sound', url: sound });
    addLog('sound', '!sound', `Playing URL: ${sound}`);
    return res.json({ ok: true });
  }

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
    } catch {}
    res.json({ ok: true });
  } catch (err) {
    addLog('obs', '!killswitch', err.message, false);
    res.status(500).json({ error: err.message });
  }
});

// Run script
app.post('/run', async (req, res) => {
  const { script } = req.body;
  const { exec } = require('child_process');
  const os = require('os');
  const platform = os.platform();

  if (!script.startsWith('http://') && !script.startsWith('https://')) {
    addLog('system', '!run', `Invalid script URL: ${script}`, false);
    return res.status(400).json({ error: 'Script must be a URL' });
  }

  const allowlist = (process.env.SCRIPT_ALLOWLIST || '').split(',').map(d => d.trim()).filter(Boolean);
  if (allowlist.length > 0) {
    const scriptHost = new URL(script).hostname;
    const allowed = allowlist.some(domain => scriptHost === domain || scriptHost.endsWith(`.${domain}`));
    if (!allowed) {
      addLog('system', '!run', `Blocked — domain not in allowlist: ${scriptHost}`, false);
      return res.status(403).json({ error: 'Script failed!' });
    }
  }

  let scriptContent;
  try {
    const fetchRes = await fetch(script);
    if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
    scriptContent = await fetchRes.text();
  } catch (err) {
    addLog('system', '!run', `Could not fetch script: ${err.message}`, false);
    return res.status(500).json({ error: 'Script failed!' });
  }

  const ext = script.split('?')[0].split('.').pop().toLowerCase();
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const isLinux = platform === 'linux';

  let command;
  const tmpFile = require('path').join(require('os').tmpdir(), `cha0s_script_${Date.now()}.${ext}`);
  require('fs').writeFileSync(tmpFile, scriptContent);

  if (ext === 'sh' && (isMac || isLinux)) {
    command = `bash "${tmpFile}"`;
  } else if (ext === 'sh' && isWindows) {
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

// --- Song request queue API ---

// Get current queue and wishlist
app.get('/api/queue', (req, res) => {
  res.json({ queue: state.queue, wishlist: state.wishlist });
});

// Manual song request from dashboard (streamer search + add)
app.post('/api/queue/add', async (req, res) => {
  const { user, query, itemId, itemName, itemArtist, itemAlbum } = req.body;
  const entry = {
    id: `req_${Date.now()}`,
    user: user || 'streamer',
    query: query || itemName,
    source: 'manual',
    resolvedItem: itemId ? { id: itemId, name: itemName, artist: itemArtist, album: itemAlbum } : null,
    status: 'pending',
    addedAt: new Date().toISOString()
  };
  state.queue.push(entry);
  broadcast({ event: 'queue_add', entry });
  addLog('jellyfin', 'queue', `Manually queued: ${itemArtist} — ${itemName}`);
  res.json({ ok: true, entry });
});

// Approve a queued request — plays it in Jellyfin
app.post('/api/queue/:id/approve', async (req, res) => {
  const entry = state.queue.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  if (!entry.resolvedItem) return res.status(400).json({ error: 'No resolved Jellyfin item' });

  try {
    const session = await getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active Jellyfin session' });

    await jellyfinRequest(`/Sessions/${session.Id}/Playing`, 'POST', {
      ItemIds: [entry.resolvedItem.id],
      PlayCommand: 'PlayNext'
    });

    entry.status = 'approved';
    broadcast({ event: 'queue_update', entry });
    addLog('jellyfin', 'queue', `Approved: ${entry.resolvedItem.artist} — ${entry.resolvedItem.name}`);
    res.json({ ok: true });
  } catch (err) {
    addLog('jellyfin', 'queue', `Approve failed: ${err.message}`, false);
    res.status(500).json({ error: err.message });
  }
});

// Skip / remove a queued entry
app.post('/api/queue/:id/skip', (req, res) => {
  const idx = state.queue.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [entry] = state.queue.splice(idx, 1);
  entry.status = 'skipped';
  broadcast({ event: 'queue_remove', id: entry.id });
  addLog('jellyfin', 'queue', `Skipped: ${entry.query}`);
  res.json({ ok: true });
});

// Remove from wishlist
app.delete('/api/wishlist/:id', (req, res) => {
  const idx = state.wishlist.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  state.wishlist.splice(idx, 1);
  broadcast({ event: 'wishlist_remove', id: req.params.id });
  res.json({ ok: true });
});

// Jellyfin library search (for dashboard search box)
app.get('/api/jellyfin/search', async (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json({ items: [] });
  try {
    if (!jellyfinToken) await authenticateJellyfin();
    const uid = jellyfinUserId;
    const path = uid
      ? `/Users/${uid}/Items?searchTerm=${encodeURIComponent(q)}&IncludeItemTypes=Audio&Recursive=true&Limit=20&Fields=Id,Name,Artists,Album,RunTimeTicks`
      : `/Items?searchTerm=${encodeURIComponent(q)}&IncludeItemTypes=Audio&Recursive=true&Limit=20&Fields=Id,Name,Artists,Album,RunTimeTicks`;
    const result = await jellyfinRequest(path);
    const items = (result?.Items || []).map(item => ({
      id: item.Id,
      name: item.Name,
      artist: item.Artists?.[0] || item.AlbumArtist || '',
      album: item.Album || '',
      duration: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10000000) : null
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Redeem actions CRUD ---
app.get('/api/redeems', (req, res) => {
  res.json({ redeems: state.redeemActions });
});

app.post('/api/redeems', (req, res) => {
  const { redeems } = req.body;
  if (typeof redeems !== 'object') return res.status(400).json({ error: 'Invalid' });
  state.redeemActions = redeems;
  process.env.REDEEM_ACTIONS = JSON.stringify(redeems);
  addLog('system', 'settings', 'Redeem actions updated');
  res.json({ ok: true });
});

// Dashboard state endpoint
app.get('/api/state', (req, res) => {
  res.json({
    obs: state.obs,
    jellyfin: state.jellyfin,
    bot: state.bot,
    twitch: state.twitch,
    log: state.log,
    mediaMode: process.env.MEDIA_CONTROL_MODE || 'jellyfin',
    srMode: process.env.SONG_REQUEST_MODE || 'chat',
    srRedeemName: process.env.SONG_REQUEST_REDEEM_NAME || '',
    srEnabled: process.env.SONG_REQUEST_ENABLED !== 'false'
  });
});

// Settings — update running config from dashboard
app.post('/settings', (req, res) => {
  const allowed = [
    'JELLYFIN_URL', 'JELLYFIN_API_KEY', 'JELLYFIN_USERNAME', 'JELLYFIN_PASSWORD',
    'JELLYFIN_DEVICE_ID', 'OBS_HOST', 'OBS_PORT', 'OBS_PASSWORD',
    'LISTENER_PORT', 'SCRIPT_ALLOWLIST', 'TWITCH_CLIENT_ID',
    'MEDIA_CONTROL_MODE', 'SONG_REQUEST_MODE', 'SONG_REQUEST_REDEEM_NAME', 'SONG_REQUEST_ENABLED'
  ];
  const updated = [];
  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) {
      process.env[key] = value;
      updated.push(key);
    }
  }
  addLog('system', 'settings', `Updated: ${updated.join(', ')}`);
  if (updated.some(k => k.startsWith('OBS_'))) {
    state.obs.connected = false;
    state.obs.reconnecting = false;
    obs.disconnect().catch(() => {});
    setTimeout(connectOBS, 500);
  }
  if (updated.some(k => k.startsWith('JELLYFIN_'))) {
    state.jellyfin.connected = false;
    jellyfinToken = null;
    jellyfinUserId = null;
    checkJellyfinConnection();
  }
  // Reconnect Twitch EventSub if credentials changed
  if (updated.some(k => k.startsWith('TWITCH_'))) {
    if (twitchWs) {
      twitchWs.removeAllListeners();
      twitchWs.close();
      twitchWs = null;
    }
    if (process.env.TWITCH_OAUTH && process.env.TWITCH_CLIENT_ID) {
      setTimeout(connectTwitchEventSub, 500);
    }
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
    twitch: state.twitch,
    log: state.log,
    mediaMode: process.env.MEDIA_CONTROL_MODE || 'jellyfin',
    srMode: process.env.SONG_REQUEST_MODE || 'chat',
    srRedeemName: process.env.SONG_REQUEST_REDEEM_NAME || '',
    srEnabled: process.env.SONG_REQUEST_ENABLED !== 'false',
    queue: state.queue,
    wishlist: state.wishlist
  }));
});

server.listen(PORT, () => {
  console.log(`Listener running on http://localhost:${PORT}`);
});
