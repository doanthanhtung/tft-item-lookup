const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { createCacheStore } = require('./cache-store');
const { createTacticsToolsClient, stableQueryKey, SITE_BASE } = require('./tactics-tools-client');
const {
  HELPER_FLAG,
  createPortableUpdateManager,
  runPortableUpdateHelper,
  writeStartupMarker,
} = require('./update-manager');

const CACHE_TTL_MS = 15 * 60 * 1000;
let mainWindow;
let cache;
let client;
let updateManager;

function readUpdateConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'update-config.json'), 'utf8'));
  } catch {
    return { enabled: false };
  }
}

function releaseUrlFromConfig(config) {
  const url = typeof config.releaseUrl === 'string' ? config.releaseUrl : '';
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/?$/i.test(url)
    ? url
    : 'https://github.com/doanthanhtung/tft-item-lookup/releases';
}

function browserFallback(url) {
  if (!url.startsWith(`${SITE_BASE}/`)) throw new Error('URL fallback không hợp lệ.');
  return new Promise((resolve, reject) => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (!window.isDestroyed()) window.destroy();
      callback(value);
    };
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-redirect', (event, nextUrl) => {
      if (!nextUrl.startsWith(`${SITE_BASE}/`)) event.preventDefault();
    });
    window.webContents.once('did-finish-load', async () => {
      try {
        const html = await window.webContents.executeJavaScript('document.documentElement.outerHTML');
        finish(resolve, html);
      } catch (error) { finish(reject, error); }
    });
    window.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
      finish(reject, Object.assign(new Error(errorDescription || 'Không tải được trang.'), { code: 'NETWORK', errorCode }));
    });
    window.loadURL(url, { userAgent: 'TFT-Item-Lookup/0.1 (personal research)' }).catch((error) => finish(reject, error));
  });
}

async function withCache(key, fetcher) {
  const cached = await cache.get(key);
  if (cached?.fresh) return { ...cached.value, cacheState: 'fresh', fetchedAt: cached.fetchedAt };
  try {
    const value = await fetcher();
    await cache.set(key, value);
    return { ...value, cacheState: 'live', fetchedAt: Date.now() };
  } catch (error) {
    if (cached) return { ...cached.value, cacheState: 'stale', fetchedAt: cached.fetchedAt, warning: 'Không tải được dữ liệu mới; đang hiển thị cache cũ.' };
    throw error;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0c111d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === SITE_BASE || url.startsWith(`${SITE_BASE}/`)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

const helperJobIndex = process.argv.indexOf(HELPER_FLAG);
if (helperJobIndex !== -1) {
  const helperJobPath = process.argv[helperJobIndex + 1];
  runPortableUpdateHelper(helperJobPath)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[portable-updater]', error);
      process.exit(1);
    });
} else {
  app.whenReady().then(() => {
    cache = createCacheStore(path.join(app.getPath('userData'), 'cache.json'), CACHE_TTL_MS);
    client = createTacticsToolsClient({ browserFallback });
    const updateConfig = readUpdateConfig();
    updateManager = createPortableUpdateManager({
      app,
      config: updateConfig,
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
      execPath: process.execPath,
      onInstallRequested: () => app.quit(),
      onStatus: (status) => {
        if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('tft:update-status', status);
      },
    });
    ipcMain.handle('tft:get-unit-catalog', () => withCache('catalog', () => client.getUnitCatalog()));
    ipcMain.handle('tft:query-explorer', (_event, filters) => withCache(`query:${stableQueryKey(filters)}`, () => client.queryExplorer(filters)));
    ipcMain.handle('tft:open-source', () => shell.openExternal(SITE_BASE));
    ipcMain.handle('tft:open-releases', () => shell.openExternal(releaseUrlFromConfig(updateConfig)));
    ipcMain.handle('tft:get-app-info', () => ({
      cacheTtlMinutes: CACHE_TTL_MS / 60000,
      source: SITE_BASE,
      version: app.getVersion(),
      updateConfigured: updateManager.isEnabled(),
      distribution: updateConfig.distribution || 'installer',
      releaseUrl: releaseUrlFromConfig(updateConfig),
    }));
    ipcMain.handle('tft:get-update-status', () => updateManager.getState());
    ipcMain.handle('tft:check-for-updates', () => updateManager.checkForUpdates());
    ipcMain.handle('tft:download-and-install-update', () => updateManager.downloadAndInstall());
    createWindow();
    writeStartupMarker(process.env.TFT_UPDATE_SUCCESS_MARKER, app.getVersion());
    updateManager.start();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
