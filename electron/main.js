const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

// Configure auto-updater
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const store = new Store({
  schema: {
    JELLYFIN_URL: { type: 'string', default: '' },
    JELLYFIN_API_KEY: { type: 'string', default: '' },
    JELLYFIN_USERNAME: { type: 'string', default: '' },
    JELLYFIN_PASSWORD: { type: 'string', default: '' },
    JELLYFIN_DEVICE_ID: { type: 'string', default: '' },
    OBS_HOST: { type: 'string', default: 'localhost' },
    OBS_PORT: { type: 'string', default: '4455' },
    OBS_PASSWORD: { type: 'string', default: '' },
    LISTENER_PORT: { type: 'string', default: '3000' },
    TWITCH_USERNAME: { type: 'string', default: '' },
    TWITCH_OAUTH: { type: 'string', default: '' },
    TWITCH_CHANNEL: { type: 'string', default: '' },
    TWITCH_CLIENT_ID: { type: 'string', default: '' },
    SCRIPT_ALLOWLIST: { type: 'string', default: '' },
    // Media control mode: 'jellyfin' or 'os'
    MEDIA_CONTROL_MODE: { type: 'string', default: 'jellyfin' },
    // Song request mode: 'chat' (!sr command), 'channel_points' (redeem), or 'both'
    SONG_REQUEST_MODE: { type: 'string', default: 'chat' },
    // The exact name of the channel point reward used for song requests (channel_points mode)
    SONG_REQUEST_REDEEM_NAME: { type: 'string', default: '' },
    // Whether song requests are enabled at all
    SONG_REQUEST_ENABLED: { type: 'string', default: 'true' },
    // JSON map of redeem title -> action config
    REDEEM_ACTIONS: { type: 'string', default: '{}' },
  }
});

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
    SCRIPT_ALLOWLIST: store.get('SCRIPT_ALLOWLIST'),
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

  listenerProcess = fork(listenerPath, [], {
    env: { ...process.env, ...config },
    silent: true
  });

  listenerProcess.stdout?.on('data', (data) => console.log('[listener]', data.toString().trim()));
  listenerProcess.stderr?.on('data', (data) => console.error('[listener error]', data.toString().trim()));
  listenerProcess.on('exit', (code) => console.log(`Listener exited with code ${code}`));
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
