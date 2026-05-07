const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

// Configure auto-updater
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// electron-store schema — all keys optional strings with safe defaults.
// We keep previously-used keys in the schema so stored values don't cause
// validation errors on upgrade. Wrap construction so a corrupted store
// doesn't crash the main process.
const STORE_SCHEMA = {
  JELLYFIN_URL:             { type: 'string', default: '' },
  JELLYFIN_API_KEY:         { type: 'string', default: '' },
  JELLYFIN_USERNAME:        { type: 'string', default: '' },
  JELLYFIN_PASSWORD:        { type: 'string', default: '' },
  JELLYFIN_DEVICE_ID:       { type: 'string', default: '' },
  OBS_HOST:                 { type: 'string', default: 'localhost' },
  OBS_PORT:                 { type: 'string', default: '4455' },
  OBS_PASSWORD:             { type: 'string', default: '' },
  LISTENER_PORT:            { type: 'string', default: '3000' },
  TWITCH_USERNAME:          { type: 'string', default: '' },  // kept for backwards compat
  TWITCH_OAUTH:             { type: 'string', default: '' },
  TWITCH_CHANNEL:           { type: 'string', default: '' },
  TWITCH_CLIENT_ID:         { type: 'string', default: '' },
  TWITCH_BOT_USERNAME:      { type: 'string', default: '' },
  TWITCH_BOT_OAUTH:         { type: 'string', default: '' },
  TWITCH_CLIENT_SECRET:     { type: 'string', default: '' },
  SCRIPT_ALLOWLIST:         { type: 'string', default: '' },
  COMMANDS_CONFIG:          { type: 'string', default: '{}' },
  REDEEM_ACTIONS:           { type: 'string', default: '{}' },
  MEDIA_CONTROL_MODE:       { type: 'string', default: 'jellyfin' },
  SONG_REQUEST_MODE:        { type: 'string', default: 'chat' },
  SONG_REQUEST_REDEEM_NAME: { type: 'string', default: '' },
  SONG_REQUEST_ENABLED:     { type: 'string', default: 'true' },
};

let store;
try {
  store = new Store({ schema: STORE_SCHEMA });
} catch (err) {
  // Schema mismatch from a previous version — clear and start fresh
  console.error('Store schema error, clearing store:', err.message);
  const Store2 = require('electron-store');
  store = new Store2();
  store.clear();
  store = new Store2({ schema: STORE_SCHEMA });
}

let mainWindow;
let listenerProcess;

function getConfig() {
  return {
    JELLYFIN_URL: store.get('JELLYFIN_URL'),
    JELLYFIN_API_KEY: store.get('JELLYFIN_API_KEY'),
    JELLYFIN_USERNAME: store.get('JELLYFIN_USERNAME'),
    JELLYFIN_PASSWORD: store.get('JELLYFIN_PASSWORD'),
    JELLYFIN_DEVICE_ID: store.get('JELLYFIN_DEVICE_ID'),
    OBS_HOST: store.get('OBS_HOST'),
    OBS_PORT: store.get('OBS_PORT'),
    OBS_PASSWORD: store.get('OBS_PASSWORD'),
    LISTENER_PORT: store.get('LISTENER_PORT'),
    TWITCH_USERNAME: store.get('TWITCH_USERNAME'),
    TWITCH_OAUTH: store.get('TWITCH_OAUTH'),
    TWITCH_CHANNEL: store.get('TWITCH_CHANNEL'),
    TWITCH_CLIENT_ID: store.get('TWITCH_CLIENT_ID'),
    TWITCH_BOT_USERNAME: store.get('TWITCH_BOT_USERNAME'),
    TWITCH_BOT_OAUTH: store.get('TWITCH_BOT_OAUTH'),
    TWITCH_CLIENT_SECRET: store.get('TWITCH_CLIENT_SECRET'),
    SCRIPT_ALLOWLIST: store.get('SCRIPT_ALLOWLIST'),
    COMMANDS_CONFIG: store.get('COMMANDS_CONFIG'),
    MEDIA_CONTROL_MODE: store.get('MEDIA_CONTROL_MODE'),
    SONG_REQUEST_MODE: store.get('SONG_REQUEST_MODE'),
    SONG_REQUEST_REDEEM_NAME: store.get('SONG_REQUEST_REDEEM_NAME'),
    SONG_REQUEST_ENABLED: store.get('SONG_REQUEST_ENABLED'),
    REDEEM_ACTIONS: store.get('REDEEM_ACTIONS'),
  };
}

function startListener(config) {
  const listenerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'listener.js')
    : path.join(__dirname, '..', 'listener.js');

  if (listenerProcess) {
    listenerProcess.kill();
    listenerProcess = null;
  }

  try {
    listenerProcess = fork(listenerPath, [], {
      env: { ...process.env, ...config },
      silent: true
    });
  } catch (err) {
    console.error('Failed to fork listener:', err.message);
    return;
  }

  listenerProcess.stdout?.on('data', (data) => console.log('[listener]', data.toString().trim()));
  listenerProcess.stderr?.on('data', (data) => console.error('[listener error]', data.toString().trim()));
  listenerProcess.on('error', (err) => console.error('[listener fork error]', err.message));
  listenerProcess.on('exit', (code, signal) => {
    console.log(`Listener exited with code ${code} signal ${signal}`);
    // Auto-restart after 3s if it crashed (not a deliberate kill)
    if (code !== 0 && code !== null) {
      console.log('Listener crashed — restarting in 3s');
      setTimeout(() => startListener(getConfig()), 3000);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    title: 'Cha0s Listener',
    backgroundColor: '#111113',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  });

  const port = store.get('LISTENER_PORT') || 3000;

  setTimeout(() => {
    mainWindow.loadURL(`http://localhost:${port}`);
    mainWindow.show();
  }, 1500);

  mainWindow.on('closed', () => { mainWindow = null; });
}

// --- Auto updater events ---
autoUpdater.on('update-available', (info) => {
  console.log(`Update available: v${info.version}`);
  if (mainWindow) {
    mainWindow.webContents.send('update-status', {
      status: 'available',
      version: info.version
    });
  }
});

autoUpdater.on('update-not-available', () => {
  console.log('App is up to date');
});

autoUpdater.on('download-progress', (progress) => {
  const percent = Math.round(progress.percent);
  console.log(`Downloading update: ${percent}%`);
  if (mainWindow) {
    mainWindow.webContents.send('update-status', {
      status: 'downloading',
      percent
    });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log(`Update downloaded: v${info.version}`);
  if (mainWindow) {
    mainWindow.webContents.send('update-status', {
      status: 'downloaded',
      version: info.version
    });
  }
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: `Cha0s Listener v${info.version} is ready to install.`,
    detail: 'The update will be installed when you quit the app, or you can restart now.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0
  }).then(({ response }) => {
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

autoUpdater.on('error', (err) => {
  console.error('Auto-updater error:', err.message);
});

// IPC for manual update check from renderer
ipcMain.handle('check-for-updates', () => {
  if (app.isPackaged) autoUpdater.checkForUpdates();
  return { ok: true };
});

// Twitch OAuth popup — opens an Electron BrowserWindow, intercepts the
// http://localhost redirect before the browser tries to load port 80,
// and returns the token directly without needing a callback server.
ipcMain.handle('twitch-oauth-popup', (event, { clientId, scopes }) => {
  return new Promise((resolve, reject) => {
    const authWin = new BrowserWindow({
      width: 600,
      height: 700,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: 'http://localhost',
      response_type: 'token',
      scope: scopes,
      force_verify: 'true'
    });

    authWin.loadURL(`https://id.twitch.tv/oauth2/authorize?${params}`);

    let settled = false;
    function settle(fn) {
      if (settled) return;
      settled = true;
      // Resolve/reject first, then destroy so the closed handler is a no-op
      fn();
      authWin.destroy();
    }

    function handleUrl(e, url) {
      if (!url.startsWith('http://localhost')) return false;
      e.preventDefault(); // stop the navigation from leaking to the system browser
      // Token lives in the fragment: http://localhost/#access_token=xxx&...
      const hashIndex = url.indexOf('#');
      if (hashIndex !== -1) {
        const fragment = url.slice(hashIndex + 1);
        const p = new URLSearchParams(fragment);
        const token = p.get('access_token');
        if (token) {
          settle(() => resolve({ token: `oauth:${token}` }));
          return true;
        }
      }
      // Error case: http://localhost/?error=access_denied&...
      try {
        const u = new URL(url);
        const err = u.searchParams.get('error');
        if (err) {
          settle(() => reject(new Error(u.searchParams.get('error_description') || err)));
          return true;
        }
      } catch {}
      return false;
    }

    authWin.webContents.on('will-redirect', (e, url) => { handleUrl(e, url); });
    authWin.webContents.on('will-navigate', (e, url) => { handleUrl(e, url); });
    authWin.on('closed', () => { if (!settled) { settled = true; reject(new Error('Cancelled')); } });
  });
});

ipcMain.handle('get-settings', () => getConfig());

ipcMain.handle('save-settings', (event, settings) => {
  for (const [key, value] of Object.entries(settings)) {
    store.set(key, value);
  }
  startListener(getConfig());
  return { ok: true };
});

app.whenReady().then(() => {
  startListener(getConfig());
  createWindow();

  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates(), 5000);
  }
});

app.on('window-all-closed', () => {
  if (listenerProcess) listenerProcess.kill();
  app.quit();
});

app.on('before-quit', () => {
  if (listenerProcess) listenerProcess.kill();
});
