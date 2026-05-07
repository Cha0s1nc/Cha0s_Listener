const dotenvPath = process.env.DOTENV_CONFIG_PATH || require('path').join(__dirname, '.env');
require('dotenv').config({ path: dotenvPath });
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const OBSWebSocket = require('obs-websocket-js').default;
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

const SOUNDS_DIR = process.env.SOUNDS_DIR ||
  (require('path').join(process.pkg ? require('path').dirname(process.execPath) : __dirname, 'sounds'));
app.use('/sounds', express.static(SOUNDS_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.LISTENER_PORT || 3000;
const OBS_HOST = process.env.OBS_HOST || 'localhost';
const OBS_PORT = process.env.OBS_PORT || 4455;
const OBS_PASSWORD = process.env.OBS_PASSWORD;

// --- Default command config ---
// permission: 'everyone' | 'subscriber' | 'vip' | 'moderator' | 'broadcaster'
// sources: any combination of 'chat' | 'whisper' | 'redemption_input'
// response: chat reply template — supports {user}, {song}, {result}, {query}. Empty = no reply.
const DEFAULT_COMMANDS = {
  song:      { enabled: true,  permission: 'everyone',    sources: ['chat','whisper'],                    response: 'Now playing: {song}',                          description: "Show what's currently playing" },
  sr:        { enabled: true,  permission: 'everyone',    sources: ['chat','whisper','redemption_input'], response: '@{user} — {result}',                           description: 'Request a song (!sr <query>)' },
  playpause: { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '{result}',                                     description: 'Toggle play/pause' },
  next:      { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '⏭ Skipped to next track',                      description: 'Skip to next track' },
  prev:      { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '⏮ Back to previous track',                     description: 'Go to previous track' },
  scene:     { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '',                                             description: 'Switch OBS scene (!scene <name>)' },
  source:    { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '',                                             description: 'Toggle OBS source (!source <name> on|off)' },
  sound:     { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '',                                             description: 'Play a sound (!sound <name>)' },
  record:    { enabled: true,  permission: 'moderator',   sources: ['chat','whisper'],                    response: '',                                             description: 'Start/stop recording (!record start|stop)' },
  run:       { enabled: false, permission: 'broadcaster', sources: ['chat','whisper'],                    response: '',                                             description: 'Run a script URL (!run <url>)' },
  killswitch:{ enabled: false, permission: 'broadcaster', sources: ['chat','whisper'],                    response: '',                                             description: 'Stop stream and recording immediately' },
};

// --- State ---
const state = {
  obs: { connected: false, reconnecting: false },
  jellyfin: { connected: false, lastChecked: null },
  twitch: { connected: false },
  log: [],
  queue: [],
  wishlist: [],
  redeemActions: {},
  commands: { ...DEFAULT_COMMANDS }
};

// Load persisted configs from env
try {
  if (process.env.REDEEM_ACTIONS) state.redeemActions = JSON.parse(process.env.REDEEM_ACTIONS);
} catch { console.log('Could not parse REDEEM_ACTIONS'); }

try {
  if (process.env.COMMANDS_CONFIG) {
    const saved = JSON.parse(process.env.COMMANDS_CONFIG);
    for (const [key, val] of Object.entries(saved)) {
      if (state.commands[key]) {
        if (typeof val.enabled === 'boolean') state.commands[key].enabled = val.enabled;
        if (val.permission) state.commands[key].permission = val.permission;
        if (Array.isArray(val.sources)) state.commands[key].sources = val.sources;
        if (typeof val.response === 'string') state.commands[key].response = val.response;
      }
    }
  }
} catch { console.log('Could not parse COMMANDS_CONFIG'); }

// --- Broadcast / log ---
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function addLog(type, command, detail, ok = true) {
  const entry = { id: Date.now(), time: new Date().toISOString(), type, command, detail, ok };
  state.log.unshift(entry);
  if (state.log.length > 100) state.log.pop();
  broadcast({ event: 'log', entry });
}

// --- Permission check ---
const PERMISSION_LEVELS = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'];

function checkPermission(chatEvent, required) {
  if (required === 'everyone') return true;
  const isBroadcaster = chatEvent.broadcaster_user_id === chatEvent.chatter_user_id;
  if (isBroadcaster) return true;
  if (required === 'broadcaster') return false;
  if (required === 'moderator') return chatEvent.badges?.some(b => b.set_id === 'moderator') || false;
  if (required === 'vip') return chatEvent.badges?.some(b => b.set_id === 'moderator' || b.set_id === 'vip') || false;
  if (required === 'subscriber') return chatEvent.badges?.some(b => ['moderator','vip','subscriber','founder'].includes(b.set_id)) || false;
  return false;
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
    broadcast({ event: 'status', service: 'obs', connected: true });
    addLog('obs', 'connect', 'OBS WebSocket connected');
  } catch (err) {
    state.obs.reconnecting = false;
    state.obs.connected = false;
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

// --- Jellyfin ---
let jellyfinToken = null;
let jellyfinUserId = null;

async function authenticateJellyfin() {
  const JELLYFIN_URL = process.env.JELLYFIN_URL;
  const username = process.env.JELLYFIN_USERNAME;
  const password = process.env.JELLYFIN_PASSWORD;
  const apiKey = process.env.JELLYFIN_API_KEY;

  if (username && password) {
    try {
      const res = await fetch(`${JELLYFIN_URL}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="Cha0s Listener", Device="Cha0s", DeviceId="cha0s_listener", Version="1.0"' },
        body: JSON.stringify({ Username: username, Pw: password })
      });
      if (res.ok) {
        const data = await res.json();
        jellyfinToken = data.AccessToken;
        jellyfinUserId = data.User?.Id || null;
        return;
      }
    } catch (err) { console.log(`Jellyfin auth error: ${err.message}`); }
  }
  if (apiKey) {
    jellyfinToken = apiKey;
    try {
      const res = await fetch(`${JELLYFIN_URL}/Users/Me`, { headers: { 'X-Emby-Token': apiKey } });
      if (res.ok) { const data = await res.json(); jellyfinUserId = data.Id || null; }
    } catch {}
  }
}

async function jellyfinRequest(path, method = 'GET', body = null) {
  const JELLYFIN_URL = process.env.JELLYFIN_URL;
  if (!jellyfinToken) await authenticateJellyfin();
  const url = `${JELLYFIN_URL}${path}`;
  const opts = { method, headers: { 'X-Emby-Token': jellyfinToken, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 401) {
    jellyfinToken = null; await authenticateJellyfin();
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

// --- OS Media Keys ---
function sendOSMediaKey(action) {
  const { exec } = require('child_process');
  const platform = require('os').platform();
  const commands = {
    playpause: { darwin: `osascript -e 'tell application "System Events" to key code 100'`, win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]179)"`, linux: `xdotool key XF86AudioPlay` },
    next:      { darwin: `osascript -e 'tell application "System Events" to key code 101'`, win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]176)"`, linux: `xdotool key XF86AudioNext` },
    prev:      { darwin: `osascript -e 'tell application "System Events" to key code 98'`,  win32: `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]177)"`, linux: `xdotool key XF86AudioPrev` }
  };
  const cmd = commands[action]?.[platform];
  if (!cmd) throw new Error(`OS media key not supported for ${action} on ${platform}`);
  return new Promise((resolve, reject) => exec(cmd, err => err ? reject(err) : resolve()));
}

// --- Twitch EventSub ---
let twitchWs = null;
let twitchReconnectTimer = null;
let twitchSessionId = null;
let twitchKeepaliveTimer = null;
let twitchKeepaliveTimeout = 15000;

async function getTwitchUserId(channelName, token) {
  const bearerToken = token.replace(/^oauth:/i, '');
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${channelName}`, {
    headers: { 'Authorization': `Bearer ${bearerToken}`, 'Client-Id': process.env.TWITCH_CLIENT_ID || '' }
  });
  if (!res.ok) throw new Error(`Twitch user lookup failed: ${res.status}`);
  const data = await res.json();
  return data.data?.[0]?.id || null;
}

async function subscribeEventSub(sessionId, type, condition) {
  const token = (process.env.TWITCH_OAUTH || '').replace(/^oauth:/i, '');
  const clientId = process.env.TWITCH_CLIENT_ID || '';
  const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, version: '1', condition, transport: { method: 'websocket', session_id: sessionId } })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    addLog('system', 'twitch', `Subscription failed (${type}): ${err.message || res.status}`, false);
  }
}

function resetKeepaliveWatchdog() {
  if (twitchKeepaliveTimer) clearTimeout(twitchKeepaliveTimer);
  twitchKeepaliveTimer = setTimeout(() => {
    addLog('system', 'twitch', 'Keepalive timeout — reconnecting', false);
    if (twitchWs) { twitchWs.removeAllListeners(); twitchWs.terminate(); twitchWs = null; }
    connectTwitchEventSub();
  }, twitchKeepaliveTimeout + 5000);
}

function attachTwitchHandlers(socket) {
  socket.on('open', () => { resetKeepaliveWatchdog(); });

  socket.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    resetKeepaliveWatchdog();
    const type = msg.metadata?.message_type;

    if (type === 'session_welcome') {
      twitchSessionId = msg.payload?.session?.id;
      const twKeepalive = msg.payload?.session?.keepalive_timeout_seconds;
      if (twKeepalive) twitchKeepaliveTimeout = (twKeepalive + 5) * 1000;
      state.twitch.connected = true;
      broadcast({ event: 'status', service: 'twitch', connected: true });
      addLog('system', 'twitch', 'EventSub connected');

      const channel = process.env.TWITCH_CHANNEL;
      const token = process.env.TWITCH_OAUTH;
      const clientId = process.env.TWITCH_CLIENT_ID;
      if (channel && token && clientId) {
        try {
          const broadcasterId = await getTwitchUserId(channel, token);
          if (broadcasterId) {
            await subscribeEventSub(twitchSessionId, 'channel.chat.message', {
              broadcaster_user_id: broadcasterId, user_id: broadcasterId
            });
            // Whisper subscription (needs user:read:whispers scope)
            await subscribeEventSub(twitchSessionId, 'user.whisper.message', {
              user_id: broadcasterId
            });
            const srMode = process.env.SONG_REQUEST_MODE || 'chat';
            const hasRedeemActions = Object.keys(state.redeemActions).length > 0;
            if (srMode === 'channel_points' || hasRedeemActions) {
              await subscribeEventSub(twitchSessionId, 'channel.channel_points_custom_reward_redemption.add', {
                broadcaster_user_id: broadcasterId
              });
            }
          }
        } catch (err) {
          addLog('system', 'twitch', `Subscription setup error: ${err.message}`, false);
        }
      }
    }

    if (type === 'session_keepalive') return;

    if (type === 'session_reconnect') {
      const url = msg.payload?.session?.reconnect_url;
      if (url) {
        const oldSocket = twitchWs;
        const newSocket = new WebSocket(url);
        twitchWs = newSocket;
        attachTwitchHandlers(newSocket);
        newSocket.once('open', () => oldSocket.close());
      }
      return;
    }

    if (type === 'notification') {
      const subType = msg.metadata?.subscription_type;
      const event = msg.payload?.event;
      if (subType === 'channel.channel_points_custom_reward_redemption.add') {
        const redeemTitle = event?.reward?.title;
        const user = event?.user_name || 'unknown';
        const input = event?.user_input || '';
        addLog('system', 'redeem', `${user} redeemed: ${redeemTitle}${input ? ` — "${input}"` : ''}`);
        await handleRedeem(redeemTitle, user, input);
      }
      if (subType === 'channel.chat.message') {
        await handleChatMessage(event);
      }
      if (subType === 'user.whisper.message') {
        await handleWhisperMessage(event);
      }
    }
  });

  socket.on('close', () => {
    if (socket !== twitchWs) return;
    if (twitchKeepaliveTimer) { clearTimeout(twitchKeepaliveTimer); twitchKeepaliveTimer = null; }
    state.twitch.connected = false;
    broadcast({ event: 'status', service: 'twitch', connected: false });
    addLog('system', 'twitch', 'EventSub disconnected — reconnecting in 15s', false);
    twitchReconnectTimer = setTimeout(connectTwitchEventSub, 15000);
  });

  socket.on('error', (err) => { console.log('Twitch EventSub error:', err.message); });
}

function connectTwitchEventSub() {
  if (twitchReconnectTimer) { clearTimeout(twitchReconnectTimer); twitchReconnectTimer = null; }
  if (!process.env.TWITCH_OAUTH || !process.env.TWITCH_CLIENT_ID) return;
  twitchWs = new WebSocket('wss://eventsub.wss.twitch.tv/ws');
  attachTwitchHandlers(twitchWs);
}

if (process.env.TWITCH_OAUTH && process.env.TWITCH_CLIENT_ID) {
  connectTwitchEventSub();
}

// --- Chat command dispatcher ---
async function handleChatMessage(event) {
  await dispatchCommand(event, 'chat',
    event?.chatter_user_name || 'unknown',
    event?.message?.text || '');
}

async function handleWhisperMessage(event) {
  // Whisper event shape: { from_user_name, whisper: { text } }
  // Build a minimal fake event so checkPermission still works correctly —
  // whispers are always treated as broadcaster-level since only the broadcaster
  // receives them and we can't check badges in whispers.
  const fakeEvent = {
    broadcaster_user_id: event?.to_user_id || '',
    chatter_user_id:     event?.from_user_id || '',
    badges: [{ set_id: 'broadcaster' }] // grant full permissions in whispers
  };
  await dispatchCommand(fakeEvent, 'whisper',
    event?.from_user_name || 'unknown',
    event?.whisper?.text || '');
}

async function dispatchCommand(permEvent, source, user, text) {
  text = (text || '').trim();
  if (!text.startsWith('!')) return;

  const parts = text.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const cfg = state.commands[cmd];

  if (!cfg) return;
  if (!cfg.enabled) return;

  // Source gate — check if this command listens to this source
  if (!cfg.sources || !cfg.sources.includes(source)) return;

  if (!checkPermission(permEvent, cfg.permission)) {
    addLog('system', `!${cmd}`, `${user} (${source}) — permission denied (need ${cfg.permission})`, false);
    return;
  }

  switch (cmd) {
    case 'song':       await cmdSong(user); break;
    case 'sr':         await cmdSongRequest(user, args.join(' ')); break;
    case 'playpause':  await cmdMediaControl(user, 'playpause'); break;
    case 'next':       await cmdMediaControl(user, 'next'); break;
    case 'prev':       await cmdMediaControl(user, 'prev'); break;
    case 'scene':      await cmdScene(user, args.join(' ')); break;
    case 'source':     await cmdSource(user, args[0], args[1]); break;
    case 'sound':      await cmdSound(user, args.join(' ')); break;
    case 'record':     await cmdRecord(user, args[0]); break;
    case 'run':        await cmdRun(user, args[0]); break;
    case 'killswitch': await cmdKillswitch(user); break;
  }
}

// --- Chat response sender ---
async function sendChatMessage(text) {
  if (!text) return;
  const clientId = process.env.TWITCH_CLIENT_ID || '';
  const channel = process.env.TWITCH_CHANNEL || '';
  if (!clientId || !channel) return;

  // Use bot token if set, otherwise fall back to broadcaster token
  const rawToken = (process.env.TWITCH_BOT_OAUTH || process.env.TWITCH_OAUTH || '').replace(/^oauth:/i, '');
  if (!rawToken) return;

  try {
    // Need broadcaster ID to address the chat room, and sender ID for the bot (or broadcaster)
    const broadcasterId = await getTwitchUserId(channel, rawToken);
    if (!broadcasterId) {
      addLog('system', 'chat', `Could not resolve broadcaster ID for channel "${channel}"`, false);
      return;
    }

    // Sender is the bot account if username is set, otherwise broadcaster sends as themselves
    const botUsername = process.env.TWITCH_BOT_USERNAME || '';
    const senderId = botUsername
      ? await getTwitchUserId(botUsername, rawToken)
      : broadcasterId;
    if (!senderId) {
      addLog('system', 'chat', `Could not resolve sender ID for bot username "${botUsername}" — is it correct?`, false);
      return;
    }

    const chatRes = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${rawToken}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        broadcaster_id: broadcasterId,
        sender_id: senderId,
        message: text.slice(0, 500) // Twitch chat message limit
      })
    });
    if (!chatRes.ok) {
      const body = await chatRes.text().catch(() => '');
      addLog('system', 'chat', `Chat send failed ${chatRes.status}: ${body}`, false);
    }
  } catch (err) {
    addLog('system', 'chat', `Failed to send message: ${err.message}`, false);
  }
}

// Fill a response template with context vars
function fillTemplate(template, vars) {
  if (!template) return '';
  return template
    .replace(/\{user\}/g, vars.user || '')
    .replace(/\{song\}/g, vars.song || '')
    .replace(/\{result\}/g, vars.result || '')
    .replace(/\{query\}/g, vars.query || '');
}

// --- Command implementations ---

async function cmdSong(user) {
  try {
    const session = await getActiveSession();
    if (!session) { addLog('jellyfin', '!song', `${user} — nothing playing`); return; }
    const item = session.NowPlayingItem;
    const artist = item.Artists?.[0] || item.AlbumArtist || 'Unknown Artist';
    const song = `${artist} — ${item.Name}`;
    addLog('jellyfin', '!song', `${user} → ${song}`);
    const tmpl = state.commands.song?.response;
    if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, song }));
  } catch (err) { addLog('jellyfin', '!song', err.message, false); }
}

async function cmdSongRequest(user, query) {
  if (!query) return;
  await handleSongRequest(user, query, 'chat');
}

async function cmdMediaControl(user, action) {
  const mediaMode = process.env.MEDIA_CONTROL_MODE || 'jellyfin';
  const commandMap = { playpause: 'PlayPause', next: 'NextTrack', prev: 'PreviousTrack' };
  const tmpl = state.commands[action]?.response;
  if (mediaMode === 'os') {
    try {
      await sendOSMediaKey(action);
      addLog('system', `!${action}`, `${user} → OS media key`);
      if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, result: '▶️ Done' }));
    } catch (err) { addLog('system', `!${action}`, err.message, false); }
  } else {
    try {
      const session = await getActiveSession();
      if (!session) { addLog('jellyfin', `!${action}`, `${user} — no active session`, false); return; }
      await jellyfinRequest(`/Sessions/${session.Id}/Playing/${commandMap[action]}`, 'POST');
      addLog('jellyfin', `!${action}`, `${user} → ${commandMap[action]}`);
      if (tmpl) {
        const result = action === 'playpause' ? '⏯ Toggled play/pause' :
                       action === 'next'      ? '⏭ Skipped to next'    : '⏮ Back to previous';
        await sendChatMessage(fillTemplate(tmpl, { user, result }));
      }
    } catch (err) { addLog('jellyfin', `!${action}`, err.message, false); }
  }
}

async function cmdScene(user, scene) {
  if (!scene) return;
  if (!state.obs.connected) { addLog('obs', '!scene', `${user} — OBS not connected`, false); return; }
  try { await obs.call('SetCurrentProgramScene', { sceneName: scene }); addLog('obs', '!scene', `${user} → ${scene}`); }
  catch (err) { addLog('obs', '!scene', err.message, false); }
}

async function cmdSource(user, source, onoff) {
  if (!source) return;
  if (!state.obs.connected) { addLog('obs', '!source', `${user} — OBS not connected`, false); return; }
  const visible = onoff?.toLowerCase() !== 'off';
  try {
    const { scenes } = await obs.call('GetSceneList');
    for (const scene of scenes) {
      const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene.sceneName });
      const item = sceneItems.find(i => i.sourceName === source);
      if (item) {
        await obs.call('SetSceneItemEnabled', { sceneName: scene.sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: visible });
        addLog('obs', '!source', `${user} → ${source} ${visible ? 'on' : 'off'}`);
        return;
      }
    }
    addLog('obs', '!source', `Source not found: ${source}`, false);
  } catch (err) { addLog('obs', '!source', err.message, false); }
}

async function cmdSound(user, sound) {
  if (!sound) return;
  const fs = require('fs'), path = require('path');
  if (sound.startsWith('http://') || sound.startsWith('https://')) {
    broadcast({ event: 'play_sound', url: sound });
    addLog('sound', '!sound', `${user} → ${sound}`);
    return;
  }
  const ext = ['mp3','wav','ogg','flac'].find(e => fs.existsSync(path.join(SOUNDS_DIR, `${sound}.${e}`)));
  if (!ext) { addLog('sound', '!sound', `File not found: ${sound}`, false); return; }
  broadcast({ event: 'play_sound', url: `/sounds/${sound}.${ext}` });
  addLog('sound', '!sound', `${user} → ${sound}.${ext}`);
}

async function cmdRecord(user, action) {
  if (!state.obs.connected) { addLog('obs', '!record', `${user} — OBS not connected`, false); return; }
  try {
    if (action === 'start') { await obs.call('StartRecord'); addLog('obs', '!record', `${user} → started`); }
    else if (action === 'stop') { await obs.call('StopRecord'); addLog('obs', '!record', `${user} → stopped`); }
    else addLog('obs', '!record', `${user} — unknown action: ${action}`, false);
  } catch (err) { addLog('obs', '!record', err.message, false); }
}

async function cmdRun(user, scriptUrl) {
  if (!scriptUrl) return;
  if (!scriptUrl.startsWith('http://') && !scriptUrl.startsWith('https://')) {
    addLog('system', '!run', `${user} — invalid URL`, false); return;
  }
  const allowlist = (process.env.SCRIPT_ALLOWLIST || '').split(',').map(d => d.trim()).filter(Boolean);
  if (allowlist.length > 0) {
    const host = new URL(scriptUrl).hostname;
    if (!allowlist.some(d => host === d || host.endsWith(`.${d}`))) {
      addLog('system', '!run', `${user} — blocked domain: ${host}`, false); return;
    }
  }
  try {
    const fetchRes = await fetch(scriptUrl);
    if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
    const scriptContent = await fetchRes.text();
    const ext = scriptUrl.split('?')[0].split('.').pop().toLowerCase();
    const platform = require('os').platform();
    const tmpFile = require('path').join(require('os').tmpdir(), `cha0s_script_${Date.now()}.${ext}`);
    require('fs').writeFileSync(tmpFile, scriptContent);
    const { exec } = require('child_process');
    let command;
    if (ext === 'sh' && platform !== 'win32') command = `bash "${tmpFile}"`;
    else if (ext === 'ps1' && platform === 'win32') command = `powershell -ExecutionPolicy Bypass -File "${tmpFile}"`;
    else if (ext === 'bat' && platform === 'win32') command = `cmd /c "${tmpFile}"`;
    else { require('fs').unlinkSync(tmpFile); addLog('system', '!run', `Unsupported on ${platform}`, false); return; }
    addLog('system', '!run', `${user} → running ${ext.toUpperCase()}`);
    exec(command, (err) => {
      try { require('fs').unlinkSync(tmpFile); } catch {}
      if (err) addLog('system', '!run', `Script failed: ${err.message}`, false);
      else addLog('system', '!run', 'Script completed');
    });
  } catch (err) { addLog('system', '!run', err.message, false); }
}

async function cmdKillswitch(user) {
  if (!state.obs.connected) { addLog('obs', '!killswitch', `${user} — OBS not connected`, false); return; }
  try {
    await obs.call('StopStream'); addLog('obs', '!killswitch', `${user} → stream stopped`);
    try { await obs.call('StopRecord'); addLog('obs', '!killswitch', 'Recording stopped'); } catch {}
  } catch (err) { addLog('obs', '!killswitch', err.message, false); }
}

// --- Redeem handler ---
async function handleRedeem(redeemTitle, user, input) {
  const action = state.redeemActions[redeemTitle];
  if (!action) {
    const srMode = process.env.SONG_REQUEST_MODE || 'chat';
    const srRedeemName = process.env.SONG_REQUEST_REDEEM_NAME || '';
    if (srMode === 'channel_points' && srRedeemName && redeemTitle === srRedeemName) {
      await handleSongRequest(user, input, 'redeem');
    }
    return;
  }
  try {
    if (action.type === 'script') await cmdRun(user, action.script);
    else if (action.type === 'sound') await cmdSound(user, action.sound);
    else if (action.type === 'scene') await cmdScene(user, action.scene);
    else if (action.type === 'source') await cmdSource(user, action.source, action.visible !== false ? 'on' : 'off');
  } catch (err) { addLog('system', `redeem:${redeemTitle}`, `Action failed: ${err.message}`, false); }
}

// --- Song request handler ---
async function handleSongRequest(user, query, source) {
  if (!query || process.env.SONG_REQUEST_ENABLED === 'false') return;
  addLog('jellyfin', '!sr', `${user} requested: ${query}`);
  let resolvedItem = null;
  try {
    if (jellyfinToken && process.env.JELLYFIN_URL) {
      const uid = jellyfinUserId;
      const searchPath = uid
        ? `/Users/${uid}/Items?searchTerm=${encodeURIComponent(query)}&IncludeItemTypes=Audio&Recursive=true&Limit=1&Fields=Id,Name,Artists,Album`
        : `/Items?searchTerm=${encodeURIComponent(query)}&IncludeItemTypes=Audio&Recursive=true&Limit=1&Fields=Id,Name,Artists,Album`;
      const result = await jellyfinRequest(searchPath);
      if (result?.Items?.length > 0) {
        const item = result.Items[0];
        resolvedItem = { id: item.Id, name: item.Name, artist: item.Artists?.[0] || item.AlbumArtist || '', album: item.Album || '' };
      }
    }
  } catch (err) { console.log('Song search error:', err.message); }

  if (!resolvedItem) {
    const entry = { id: `wish_${Date.now()}`, user, query, addedAt: new Date().toISOString() };
    state.wishlist.unshift(entry);
    if (state.wishlist.length > 200) state.wishlist.pop();
    broadcast({ event: 'wishlist_add', entry });
    addLog('jellyfin', '!sr', `"${query}" not in library — added to wishlist`, false);
    const tmpl = state.commands.sr?.response;
    if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, query, result: `"${query}" wasn't found in the library — added to the wishlist!` }));
  } else {
    const entry = { id: `req_${Date.now()}`, user, query, source, resolvedItem, status: 'pending', addedAt: new Date().toISOString() };
    state.queue.push(entry);
    broadcast({ event: 'queue_add', entry });
    addLog('jellyfin', '!sr', `Queued: ${resolvedItem.artist} — ${resolvedItem.name}`);
    const tmpl = state.commands.sr?.response;
    if (tmpl) await sendChatMessage(fillTemplate(tmpl, { user, query, result: `"${resolvedItem.artist} — ${resolvedItem.name}" added to the queue!` }));
  }
}

// --- HTTP Routes (kept for external compat) ---
app.post('/media', async (req, res) => {
  const { action } = req.body;
  if (action === 'song') {
    try {
      const session = await getActiveSession();
      if (!session) return res.json({ nothing: true });
      const item = session.NowPlayingItem;
      return res.json({ song: `${item.Artists?.[0] || item.AlbumArtist || 'Unknown'} — ${item.Name}` });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }
  const commandMap = { playpause: 'PlayPause', next: 'NextTrack', prev: 'PreviousTrack' };
  const command = commandMap[action];
  if (!command) return res.status(400).json({ error: `Unknown action: ${action}` });
  if (process.env.MEDIA_CONTROL_MODE === 'os') {
    try { await sendOSMediaKey(action); return res.json({ ok: true }); }
    catch (err) { return res.status(500).json({ error: err.message }); }
  }
  try {
    const session = await getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    await jellyfinRequest(`/Sessions/${session.Id}/Playing/${command}`, 'POST');
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/sound', async (req, res) => {
  await cmdSound('http', req.body.sound);
  res.json({ ok: true });
});
app.post('/scene', async (req, res) => {
  await cmdScene('http', req.body.scene);
  res.json({ ok: true });
});
app.post('/source', async (req, res) => {
  const { source, visible } = req.body;
  await cmdSource('http', source, visible ? 'on' : 'off');
  res.json({ ok: true });
});
app.post('/recording', async (req, res) => {
  await cmdRecord('http', req.body.action);
  res.json({ ok: true });
});
app.post('/killswitch', async (req, res) => {
  await cmdKillswitch('http');
  res.json({ ok: true });
});
app.post('/run', async (req, res) => {
  await cmdRun('http', req.body.script);
  res.json({ ok: true });
});

// --- Queue API ---
app.get('/api/queue', (req, res) => res.json({ queue: state.queue, wishlist: state.wishlist }));

app.post('/api/queue/add', async (req, res) => {
  const { user, query, itemId, itemName, itemArtist, itemAlbum } = req.body;
  const entry = { id: `req_${Date.now()}`, user: user || 'streamer', query: query || itemName, source: 'manual', resolvedItem: itemId ? { id: itemId, name: itemName, artist: itemArtist, album: itemAlbum } : null, status: 'pending', addedAt: new Date().toISOString() };
  state.queue.push(entry);
  broadcast({ event: 'queue_add', entry });
  addLog('jellyfin', 'queue', `Manually queued: ${itemArtist} — ${itemName}`);
  res.json({ ok: true, entry });
});

app.post('/api/queue/:id/approve', async (req, res) => {
  const entry = state.queue.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  if (!entry.resolvedItem) return res.status(400).json({ error: 'No resolved item' });
  try {
    const session = await getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    await jellyfinRequest(`/Sessions/${session.Id}/Playing`, 'POST', { ItemIds: [entry.resolvedItem.id], PlayCommand: 'PlayNext' });
    entry.status = 'approved';
    broadcast({ event: 'queue_update', entry });
    addLog('jellyfin', 'queue', `Approved: ${entry.resolvedItem.artist} — ${entry.resolvedItem.name}`);
    res.json({ ok: true });
  } catch (err) { addLog('jellyfin', 'queue', `Approve failed: ${err.message}`, false); res.status(500).json({ error: err.message }); }
});

app.post('/api/queue/:id/skip', (req, res) => {
  const idx = state.queue.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [entry] = state.queue.splice(idx, 1);
  broadcast({ event: 'queue_remove', id: entry.id });
  addLog('jellyfin', 'queue', `Skipped: ${entry.query}`);
  res.json({ ok: true });
});

app.delete('/api/wishlist/:id', (req, res) => {
  const idx = state.wishlist.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  state.wishlist.splice(idx, 1);
  broadcast({ event: 'wishlist_remove', id: req.params.id });
  res.json({ ok: true });
});

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
      id: item.Id, name: item.Name, artist: item.Artists?.[0] || item.AlbumArtist || '',
      album: item.Album || '', duration: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10000000) : null
    }));
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/redeems', (req, res) => res.json({ redeems: state.redeemActions }));
app.post('/api/redeems', (req, res) => {
  const { redeems } = req.body;
  if (typeof redeems !== 'object') return res.status(400).json({ error: 'Invalid' });
  state.redeemActions = redeems;
  process.env.REDEEM_ACTIONS = JSON.stringify(redeems);
  addLog('system', 'settings', 'Redeem actions updated');
  res.json({ ok: true });
});

app.get('/api/commands', (req, res) => res.json({ commands: state.commands }));
app.post('/api/commands', (req, res) => {
  const { commands } = req.body;
  if (typeof commands !== 'object') return res.status(400).json({ error: 'Invalid' });
  for (const [key, val] of Object.entries(commands)) {
    if (state.commands[key]) {
      if (typeof val.enabled === 'boolean') state.commands[key].enabled = val.enabled;
      if (PERMISSION_LEVELS.includes(val.permission)) state.commands[key].permission = val.permission;
      if (Array.isArray(val.sources)) state.commands[key].sources = val.sources;
    }
  }
  process.env.COMMANDS_CONFIG = JSON.stringify(state.commands);
  broadcast({ event: 'commands_update', commands: state.commands });
  addLog('system', 'settings', 'Command config updated');
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => res.json({
  obs: state.obs, jellyfin: state.jellyfin, twitch: state.twitch, log: state.log,
  mediaMode: process.env.MEDIA_CONTROL_MODE || 'jellyfin',
  srMode: process.env.SONG_REQUEST_MODE || 'chat',
  srRedeemName: process.env.SONG_REQUEST_REDEEM_NAME || '',
  srEnabled: process.env.SONG_REQUEST_ENABLED !== 'false'
}));

app.post('/settings', (req, res) => {
  const allowed = [
    'JELLYFIN_URL','JELLYFIN_API_KEY','JELLYFIN_USERNAME','JELLYFIN_PASSWORD','JELLYFIN_DEVICE_ID',
    'OBS_HOST','OBS_PORT','OBS_PASSWORD','LISTENER_PORT','SCRIPT_ALLOWLIST','TWITCH_CLIENT_ID',
    'TWITCH_CLIENT_SECRET','MEDIA_CONTROL_MODE','SONG_REQUEST_MODE','SONG_REQUEST_REDEEM_NAME',
    'SONG_REQUEST_ENABLED','TWITCH_BOT_USERNAME','TWITCH_BOT_OAUTH'
  ];
  const updated = [];
  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) { process.env[key] = value; updated.push(key); }
  }
  addLog('system', 'settings', `Updated: ${updated.join(', ')}`);
  if (updated.some(k => k.startsWith('OBS_'))) {
    state.obs.connected = false; state.obs.reconnecting = false;
    obs.disconnect().catch(() => {}); setTimeout(connectOBS, 500);
  }
  if (updated.some(k => k.startsWith('JELLYFIN_'))) {
    state.jellyfin.connected = false; jellyfinToken = null; jellyfinUserId = null;
    checkJellyfinConnection();
  }
  if (updated.some(k => k.startsWith('TWITCH_'))) {
    if (twitchWs) { twitchWs.removeAllListeners(); twitchWs.terminate(); twitchWs = null; }
    if (twitchKeepaliveTimer) { clearTimeout(twitchKeepaliveTimer); twitchKeepaliveTimer = null; }
    if (process.env.TWITCH_OAUTH && process.env.TWITCH_CLIENT_ID) setTimeout(connectTwitchEventSub, 500);
  }
  res.json({ ok: true, updated });
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    event: 'init',
    obs: state.obs, jellyfin: state.jellyfin, twitch: state.twitch, log: state.log,
    mediaMode: process.env.MEDIA_CONTROL_MODE || 'jellyfin',
    srMode: process.env.SONG_REQUEST_MODE || 'chat',
    srRedeemName: process.env.SONG_REQUEST_REDEEM_NAME || '',
    srEnabled: process.env.SONG_REQUEST_ENABLED !== 'false',
    queue: state.queue, wishlist: state.wishlist,
    commands: state.commands
  }));
});

// --- Twitch OAuth flow ---
// Uses Authorization Code flow so the entire exchange happens server-side.
//
// If TWITCH_CLIENT_SECRET is set: standard code + secret exchange.
// If not: PKCE (public client) — no secret required, still server-side.
//
// Only ONE redirect URI to register in dev.twitch.tv:
//   http://localhost:{PORT}/twitch/auth/callback
//
// Flow:
//   1. POST /twitch/auth/start (or /bot/start) → opens system browser
//   2. Twitch redirects to GET /twitch/auth/callback?code=xxx&state=xxx
//   3. Server exchanges code → token (no browser JS needed)
//   4. Server broadcasts oauth_token (or oauth_bot_token) via WebSocket
//   5. Dashboard fills in the field and saves only the relevant token

const TWITCH_SCOPES = [
  'user:read:chat',
  'channel:bot',
  'channel:read:redemptions',
  'user:read:whispers',
  'whispers:read',
  'moderator:read:chat_messages'
].join(' ');

const TWITCH_BOT_SCOPES = 'user:write:chat';

// Pending flows keyed by state token: { type, clientId, redirectUri, pkceVerifier, expiresAt }
const pendingOAuthFlows = new Map();

// Clean up expired flows every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingOAuthFlows) {
    if (val.expiresAt < now) pendingOAuthFlows.delete(key);
  }
}, 600000);

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}
function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function openBrowser(url) {
  const { exec } = require('child_process');
  const platform = require('os').platform();
  const safe = url.replace(/"/g, '\\"');
  const cmd = platform === 'win32' ? `start "" "${safe}"` :
              platform === 'darwin' ? `open "${safe}"` : `xdg-open "${safe}"`;
  exec(cmd, (err) => {
    if (err) addLog('system', 'twitch', `Could not open browser: ${err.message}`, false);
  });
}

function startOAuthFlow(clientId, scopes, flowType, res) {
  const port = process.env.LISTENER_PORT || PORT;
  const redirectUri = `http://localhost:${port}/twitch/auth/callback`;
  const stateToken = crypto.randomBytes(16).toString('hex');
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;

  const flow = { type: flowType, clientId, redirectUri, expiresAt: Date.now() + 600000 };

  const params = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    state: stateToken
  };

  if (!clientSecret) {
    // No secret — use PKCE so the exchange is still secure
    flow.pkceVerifier = generateCodeVerifier();
    params.code_challenge = generateCodeChallenge(flow.pkceVerifier);
    params.code_challenge_method = 'S256';
  }

  pendingOAuthFlows.set(stateToken, flow);

  const authUrl = `https://id.twitch.tv/oauth2/authorize?` + new URLSearchParams(params);
  openBrowser(authUrl);
  addLog('system', 'twitch', `OAuth: opened browser (${flowType})`);
  res.json({ ok: true, redirectUri });
}

// Single redirect URI — only ONE URL to register in dev.twitch.tv
app.get('/twitch/auth/info', (req, res) => {
  const port = process.env.LISTENER_PORT || PORT;
  const uri = `http://localhost:${port}/twitch/auth/callback`;
  res.json({ broadcaster: uri, bot: uri });
});

app.post('/twitch/auth/start', (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID || req.body?.clientId || '';
  if (!clientId) return res.status(400).json({ error: 'No Client ID configured' });
  startOAuthFlow(clientId, TWITCH_SCOPES, 'broadcaster', res);
});

app.post('/twitch/auth/bot/start', (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID || req.body?.clientId || '';
  if (!clientId) return res.status(400).json({ error: 'No Client ID configured' });
  startOAuthFlow(clientId, TWITCH_BOT_SCOPES, 'bot', res);
});

// Twitch redirects here with ?code=xxx&state=xxx — exchange the code server-side
app.get('/twitch/auth/callback', async (req, res) => {
  const pageStyle = `<style>
    body { font-family: -apple-system, sans-serif; background: #111113; color: #f5f5f7;
           display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1c1c1e; border: 1px solid #3a3a3c; border-radius: 12px;
            padding: 28px 36px; text-align: center; max-width: 420px; }
    h2 { margin: 0 0 8px; font-size: 18px; }
    p  { margin: 0; font-size: 13px; color: #aeaeb2; }
    .ok   { color: #32d74b; font-size: 32px; }
    .fail { color: #ff453a; font-size: 32px; }
  </style>`;

  function page(icon, title, msg) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Cha0s Listener</title>${pageStyle}</head>
      <body><div class="card"><div>${icon}</div><h2>${title}</h2><p>${msg}</p></div></body></html>`;
  }

  const { code, state, error, error_description } = req.query;

  if (error) {
    addLog('system', 'twitch', `OAuth denied: ${error}`, false);
    return res.send(page('❌', 'Authorization cancelled', error_description || error));
  }
  if (!code || !state) {
    return res.send(page('❌', 'Missing parameters', 'No code or state in the redirect. Please try again.'));
  }

  const flow = pendingOAuthFlows.get(state);
  if (!flow) {
    return res.send(page('❌', 'Session expired', 'This authorization link has expired. Please try again from the app.'));
  }
  if (flow.expiresAt < Date.now()) {
    pendingOAuthFlows.delete(state);
    return res.send(page('❌', 'Session expired', 'The authorization timed out. Please try again.'));
  }
  pendingOAuthFlows.delete(state);

  try {
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    const bodyParams = new URLSearchParams({
      client_id: flow.clientId,
      code,
      grant_type: 'authorization_code',
      redirect_uri: flow.redirectUri
    });
    if (clientSecret) {
      bodyParams.set('client_secret', clientSecret);
    } else if (flow.pkceVerifier) {
      bodyParams.set('code_verifier', flow.pkceVerifier);
    }

    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParams
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      const msg = tokenData.message || `HTTP ${tokenRes.status}`;
      addLog('system', 'twitch', `OAuth token exchange failed: ${msg}`, false);
      return res.send(page('❌', 'Token exchange failed', msg + '<br><br>Check your Client ID and Secret in settings.'));
    }

    const oauthToken = `oauth:${tokenData.access_token}`;

    if (flow.type === 'bot') {
      process.env.TWITCH_BOT_OAUTH = oauthToken;
      addLog('system', 'twitch', 'Bot OAuth token acquired');
      broadcast({ event: 'oauth_bot_token', token: oauthToken });
      res.send(page('✅', 'Bot authorized!', 'Token saved. You can close this tab.'));
    } else {
      process.env.TWITCH_OAUTH = oauthToken;
      addLog('system', 'twitch', 'OAuth token acquired');
      broadcast({ event: 'oauth_token', token: oauthToken });
      // Reconnect EventSub with the fresh token
      if (twitchWs) { twitchWs.removeAllListeners(); twitchWs.terminate(); twitchWs = null; }
      if (twitchKeepaliveTimer) { clearTimeout(twitchKeepaliveTimer); twitchKeepaliveTimer = null; }
      setTimeout(connectTwitchEventSub, 500);
      res.send(page('✅', 'Authorized!', 'Token saved. You can close this tab.'));
    }
  } catch (err) {
    addLog('system', 'twitch', `OAuth callback error: ${err.message}`, false);
    res.send(page('❌', 'Error', err.message));
  }
});

server.listen(PORT, () => console.log(`Listener running on http://localhost:${PORT}`));
