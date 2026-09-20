const DEFAULT_CHECK_DELAY_MS = 15 * 1000;

function getFeedConfig(config = {}) {
  if (config.provider === 'github' && config.owner && config.repo) {
    return {
      provider: 'github',
      owner: String(config.owner),
      repo: String(config.repo),
      private: Boolean(config.private),
    };
  }
  if (config.provider === 'generic' && typeof config.url === 'string' && /^https:\/\//i.test(config.url)) {
    return { provider: 'generic', url: config.url };
  }
  return null;
}

function createUpdateManager({ updater, isPackaged = false, platform = process.platform, config = {}, onStatus = () => {}, logger = console } = {}) {
  const feedConfig = getFeedConfig(config);
  const enabled = Boolean(updater && isPackaged && platform === 'win32' && config.distribution !== 'portable' && config.enabled && feedConfig);
  let state = {
    configured: enabled,
    status: enabled ? 'idle' : 'disabled',
    currentVersion: null,
    availableVersion: null,
    progress: 0,
    error: null,
  };

  const emit = (next) => {
    const previous = state;
    state = { ...state, ...next };
    if (Object.keys(state).every((key) => state[key] === previous[key])) return state;
    onStatus({ ...state });
    return state;
  };

  const safeLog = (method, ...args) => {
    try { logger?.[method]?.(...args); } catch { /* logging must not break updates */ }
  };

  if (enabled) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    try {
      updater.setFeedURL(feedConfig);
      updater.on('checking-for-update', () => emit({ status: 'checking', error: null }));
      updater.on('update-available', (info = {}) => emit({ status: 'available', availableVersion: info.version || null, progress: 0, error: null }));
      updater.on('update-not-available', () => emit({ status: 'not-available', availableVersion: null, progress: 0, error: null }));
      updater.on('download-progress', (progress = {}) => emit({ status: 'downloading', progress: Number(progress.percent) || 0, error: null }));
      updater.on('update-downloaded', (info = {}) => emit({ status: 'downloaded', availableVersion: info.version || state.availableVersion, progress: 100, error: null }));
      updater.on('error', (error) => {
        const message = error?.message || 'Không thể kiểm tra cập nhật.';
        safeLog('warn', '[updater]', message);
        emit({ status: 'error', error: message });
      });
    } catch (error) {
      emit({ status: 'error', error: error.message || 'Không thể cấu hình cập nhật.' });
    }
  }

  return {
    getState: () => ({ ...state }),
    isEnabled: () => enabled,
    async checkForUpdates() {
      if (!enabled) return { ...state };
      emit({ status: 'checking', error: null });
      try {
        await updater.checkForUpdates();
      } catch (error) {
        emit({ status: 'error', error: error?.message || 'Không thể kiểm tra cập nhật.' });
      }
      return { ...state };
    },
    async downloadUpdate() {
      if (!enabled) return { ...state };
      emit({ status: 'downloading', progress: 0, error: null });
      try {
        await updater.downloadUpdate();
      } catch (error) {
        emit({ status: 'error', error: error?.message || 'Không thể tải bản cập nhật.' });
      }
      return { ...state };
    },
    installUpdate() {
      if (!enabled || state.status !== 'downloaded') return { ...state };
      updater.quitAndInstall(false, true);
      return { ...state };
    },
    start(delayMs = DEFAULT_CHECK_DELAY_MS) {
      if (!enabled) return null;
      return setTimeout(() => { this.checkForUpdates(); }, delayMs);
    },
  };
}

module.exports = { createUpdateManager, getFeedConfig };
