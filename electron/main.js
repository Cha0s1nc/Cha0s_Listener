const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const Store = require('electron-store');

const store = new Store({
  schema: {
    JELLYFIN_URL: { type: 'string', default: '' },
    JELLYFIN_API_KEY: { type: 'string', default: '' },
    JELLYFIN_DEVICE_ID: { type: 'string', default: '' },
    OBS_HOST: { type: 'string', default: 'localhost' },
    OBS_PORT: { type: 'string', default: '4455' },
    OBS_PASSWORD: { type: 'string', default: '' },
    LISTENER_PORT: { type: 'string', default: '3000' },
    TWITCH_USERNAME: { type: 'string', default: '' },
    TWITCH_OAUTH: { type: 'string', default: '' },
    TWITCH_CHANNEL: { type: 'string', default: '' },
  }
});

let mainWindow;
let listenerProcess;

function getConfig() {
  return {
    JELLYFIN_URL: store.get('JELLYFIN_URL'),
    JELLYFIN_API_KEY: store.get('JELLYFIN_API_KEY'),
    JELLYFIN_DEVICE_ID: store.get('JELLYFIN_DEVICE_ID'),
    OBS_HOST: store.get('OBS_HOST'),
    OBS_PORT: store.get('OBS_PORT'),
    OBS_PASSWORD: store.get('OBS_PASSWORD'),
    LISTENER_PORT: store.get('LISTENER_PORT'),
    TWITCH_USERNAME: store.get('TWITCH_USERNAME'),
    TWITCH_OAUTH: store.get('TWITCH_OAUTH'),
    TWITCH_CHANNEL: store.get('TWITCH_CHANNEL'),
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
});

app.on('window-all-closed', () => {
  if (listenerProcess) listenerProcess.kill();
  app.quit();
});

app.on('before-quit', () => {
  if (listenerProcess) listenerProcess.kill();
});
