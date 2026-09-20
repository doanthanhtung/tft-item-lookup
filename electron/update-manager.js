const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const DEFAULT_CHECK_DELAY_MS = 15 * 1000;
const DEFAULT_TIMEOUT_MS = 20 * 1000;
const MAX_UPDATE_BYTES = 300 * 1024 * 1024;
const HELPER_FLAG = '--tft-update-helper';
const STARTUP_MARKER_ENV = 'TFT_UPDATE_SUCCESS_MARKER';

function parseVersion(value) {
  const match = typeof value === 'string' && value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] || '' };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error('Version không hợp lệ.');
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre === b.pre ? 0 : a.pre > b.pre ? 1 : -1;
}

function getManifestUrl(config = {}) {
  if (typeof config.manifestUrl !== 'string' || !/^https:\/\//i.test(config.manifestUrl)) return null;
  return config.manifestUrl;
}

function validateManifest(raw, { config = {}, currentVersion = '0.0.0' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Manifest cập nhật không hợp lệ.');
  const version = String(raw.version || '');
  if (raw.schemaVersion !== 1 || !parseVersion(version)) throw new Error('Manifest cập nhật không đúng schema.');
  if (!config.owner || !config.repo) throw new Error('Thiếu repository cập nhật.');

  const releasePrefix = 'https://github.com/' + config.owner + '/' + config.repo + '/releases/download/v' + version + '/';
  const expectedAssetName = 'TFT-Item-Lookup-' + version + '-portable.exe';
  if (raw.assetName !== expectedAssetName) throw new Error('Artifact cập nhật không đúng tên.');
  if (raw.platform !== 'win32-x64') throw new Error('Platform cập nhật không được hỗ trợ.');
  if (raw.downloadUrl !== releasePrefix + expectedAssetName) throw new Error('URL download cập nhật không được phép.');
  if (!/^[a-f0-9]{64}$/i.test(String(raw.sha256 || ''))) throw new Error('SHA-256 trong manifest không hợp lệ.');
  if (!Number.isSafeInteger(raw.size) || raw.size <= 0 || raw.size > MAX_UPDATE_BYTES) throw new Error('Kích thước cập nhật không hợp lệ.');
  const releasePrefixForPage = 'https://github.com/' + config.owner + '/' + config.repo + '/releases/';
  const expectedReleaseUrl = releasePrefixForPage + 'tag/v' + version;
  if (raw.releaseUrl && raw.releaseUrl !== expectedReleaseUrl) throw new Error('URL release cập nhật không được phép.');

  return {
    schemaVersion: 1,
    version,
    platform: raw.platform || 'win32-x64',
    assetName: raw.assetName,
    downloadUrl: raw.downloadUrl,
    sha256: String(raw.sha256).toLowerCase(),
    size: raw.size,
    releaseUrl: raw.releaseUrl || expectedReleaseUrl,
    isNewer: compareVersions(version, currentVersion) > 0,
  };
}

async function fetchJson(fetchImpl, url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) {
      const error = new Error('HTTP ' + response.status);
      error.code = 'HTTP_' + response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function writeDownload(fetchImpl, url, destination, { expectedSize, maxBytes = MAX_UPDATE_BYTES, onProgress = () => {} } = {}) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) {
    const error = new Error('HTTP ' + response.status);
    error.code = 'HTTP_' + response.status;
    throw error;
  }
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (contentLength > maxBytes || (expectedSize && contentLength && contentLength !== expectedSize)) {
    throw new Error('Kích thước file cập nhật không hợp lệ.');
  }
  if (!response.body) throw new Error('Response cập nhật không có dữ liệu.');

  const stream = typeof response.body.getReader === 'function'
    ? require('node:stream').Readable.fromWeb(response.body)
    : response.body;
  const output = fs.createWriteStream(destination, { flags: 'wx' });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maxBytes || (expectedSize && bytes > expectedSize)) throw new Error('File cập nhật vượt quá giới hạn.');
      hash.update(chunk);
      if (!output.write(chunk)) await once(output, 'drain');
      onProgress(expectedSize ? Math.min(100, (bytes / expectedSize) * 100) : 0);
    }
    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    await fsp.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  if (expectedSize && bytes !== expectedSize) {
    await fsp.rm(destination, { force: true }).catch(() => {});
    throw new Error('File cập nhật bị thiếu dữ liệu.');
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(filePath);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

function processExists(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid, timeoutMs = 30000, intervalMs = 250, exists = processExists) {
  const deadline = Date.now() + timeoutMs;
  while (exists(pid) && Date.now() < deadline) await sleep(intervalMs);
  if (exists(pid)) throw new Error('Ứng dụng cũ chưa đóng đúng hạn.');
}

async function waitForFile(filePath, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await sleep(intervalMs);
  }
  return fs.existsSync(filePath);
}

async function removeFile(filePath) {
  if (filePath) await fsp.rm(filePath, { force: true }).catch(() => {});
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    require('node:child_process').execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    try { process.kill(pid); } catch { /* process may already be gone */ }
  }
}

async function runPortableUpdateHelper(jobPath, {
  spawnImpl = spawn,
  processExistsImpl = processExists,
  killProcessImpl = killProcessTree,
  startupTimeoutMs = 15000,
  startupPollIntervalMs = 250,
  logger = console,
} = {}) {
  let job;
  try {
    job = JSON.parse(await fsp.readFile(jobPath, 'utf8'));
  } catch (error) {
    throw new Error('Không đọc được update job: ' + error.message);
  }
  const targetPath = path.resolve(String(job.targetPath || ''));
  const stagedPath = path.resolve(String(job.stagedPath || ''));
  const markerPath = path.resolve(String(job.markerPath || ''));
  if (!targetPath.toLowerCase().endsWith('.exe') || !stagedPath.toLowerCase().endsWith('.exe')) {
    throw new Error('Update job có đường dẫn không hợp lệ.');
  }

  await waitForProcessExit(job.parentPid, job.parentTimeoutMs || 30000, 250, processExistsImpl);
  if (!fs.existsSync(targetPath) || !fs.existsSync(stagedPath)) throw new Error('Thiếu file cho quá trình cập nhật.');
  if (job.sha256 && (await sha256File(stagedPath)) !== String(job.sha256).toLowerCase()) {
    throw new Error('SHA-256 file cập nhật không khớp.');
  }

  const suffix = '.tft-update-' + process.pid + '-' + Date.now();
  const stagedTarget = targetPath + suffix + '.new';
  const backupPath = targetPath + suffix + '.backup';
  let replaced = false;
  let launched;
  try {
    await fsp.copyFile(stagedPath, stagedTarget);
    if (job.sha256 && (await sha256File(stagedTarget)) !== String(job.sha256).toLowerCase()) {
      throw new Error('SHA-256 bản copy cập nhật không khớp.');
    }
    await fsp.rename(targetPath, backupPath);
    await fsp.rename(stagedTarget, targetPath);
    replaced = true;

    launched = spawnImpl(targetPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: { ...process.env, [STARTUP_MARKER_ENV]: markerPath },
    });
    launched.unref?.();
    if (!(await waitForFile(markerPath, startupTimeoutMs, startupPollIntervalMs))) throw new Error('Bản cập nhật không khởi động thành công.');

    await removeFile(backupPath);
    await removeFile(stagedPath);
    await removeFile(jobPath);
    await removeFile(markerPath);
    return { ok: true, targetPath };
  } catch (error) {
    if (launched?.pid) killProcessImpl(launched.pid);
    if (replaced) {
      await removeFile(targetPath);
      if (fs.existsSync(backupPath)) await fsp.rename(backupPath, targetPath).catch(() => {});
    }
    await removeFile(stagedTarget);
    await removeFile(stagedPath);
    await removeFile(jobPath);
    await removeFile(markerPath);
    logger?.error?.('[portable-updater]', error.message);
    throw error;
  }
}

function writeStartupMarker(markerPath, version) {
  if (!markerPath) return;
  try {
    const resolved = path.resolve(markerPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify({ version, startedAt: new Date().toISOString() }), 'utf8');
  } catch {
    // A marker failure must not prevent the app from opening.
  }
}

function createPortableUpdateManager({
  app,
  config = {},
  currentVersion = '0.0.0',
  isPackaged = false,
  platform = process.platform,
  portableExecutableFile = process.env.PORTABLE_EXECUTABLE_FILE,
  execPath = process.execPath,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  onInstallRequested = () => {},
  onStatus = () => {},
  logger = console,
} = {}) {
  const configured = Boolean(isPackaged && platform === 'win32' && config.enabled && config.distribution === 'portable' && getManifestUrl(config));
  const enabled = Boolean(configured && portableExecutableFile && fetchImpl);
  let state = {
    configured,
    status: enabled ? 'idle' : configured ? 'error' : 'disabled',
    currentVersion,
    availableVersion: null,
    progress: 0,
    error: enabled ? null : configured ? 'Không xác định được file portable hiện tại.' : null,
    releaseUrl: null,
  };

  const emit = (next) => {
    const previous = state;
    state = { ...state, ...next };
    if (Object.keys(state).every((key) => state[key] === previous[key])) return state;
    onStatus({ ...state });
    return state;
  };

  const manager = {
    getState: () => ({ ...state }),
    isEnabled: () => enabled,
    async checkForUpdates() {
      if (!enabled) return { ...state };
      emit({ status: 'checking', error: null, progress: 0 });
      try {
        const manifest = validateManifest(await fetchJson(fetchImpl, getManifestUrl(config)), { config, currentVersion });
        if (!manifest.isNewer) return emit({ status: 'not-available', availableVersion: null, releaseUrl: null, manifest: null, error: null });
        return emit({ status: 'available', availableVersion: manifest.version, releaseUrl: manifest.releaseUrl, manifest, error: null });
      } catch (error) {
        logger?.warn?.('[portable-updater]', error.message);
        return emit({ status: 'error', error: error.message || 'Không thể kiểm tra cập nhật.' });
      }
    },
    async downloadAndInstall() {
      if (!enabled || state.status !== 'available' || !state.manifest) return { ...state };
      const manifest = state.manifest;
      const tempRoot = app?.getPath?.('temp') || os.tmpdir();
      const updateDir = path.join(tempRoot, 'tft-item-lookup-updates');
      const stagedPath = path.join(updateDir, manifest.assetName + '.' + process.pid + '.part');
      const jobPath = path.join(updateDir, 'update-job-' + process.pid + '.json');
      const markerPath = path.join(updateDir, 'startup-' + process.pid + '.json');
      try {
        await fsp.mkdir(updateDir, { recursive: true });
        await removeFile(stagedPath);
        emit({ status: 'downloading', progress: 0, error: null });
        const result = await writeDownload(fetchImpl, manifest.downloadUrl, stagedPath, {
          expectedSize: manifest.size,
          onProgress: (progress) => emit({ status: 'downloading', progress }),
        });
        emit({ status: 'verifying', progress: 100, error: null });
        if (result.sha256 !== manifest.sha256) throw new Error('SHA-256 file tải xuống không khớp manifest.');
        const finalizedPath = path.join(updateDir, manifest.assetName + '.' + process.pid + '.exe');
        await removeFile(finalizedPath);
        await fsp.rename(stagedPath, finalizedPath);
        await fsp.writeFile(jobPath, JSON.stringify({
          targetPath: path.resolve(portableExecutableFile),
          stagedPath: finalizedPath,
          markerPath,
          parentPid: process.pid,
          sha256: manifest.sha256,
          parentTimeoutMs: 30000,
        }), 'utf8');
        emit({ status: 'installing', progress: 100, error: null });
        const helper = spawnImpl(execPath, [HELPER_FLAG, jobPath], { detached: true, stdio: 'ignore', windowsHide: true });
        helper.unref?.();
        onInstallRequested();
        return { ...state };
      } catch (error) {
        await removeFile(stagedPath);
        await removeFile(jobPath);
        logger?.warn?.('[portable-updater]', error.message);
        return emit({ status: 'error', error: error.message || 'Không thể cập nhật.' });
      }
    },
    start(delayMs = DEFAULT_CHECK_DELAY_MS) {
      if (!enabled) return null;
      return setTimeout(() => { manager.checkForUpdates(); }, delayMs);
    },
  };
  return manager;
}

module.exports = {
  DEFAULT_CHECK_DELAY_MS,
  HELPER_FLAG,
  MAX_UPDATE_BYTES,
  compareVersions,
  createPortableUpdateManager,
  getManifestUrl,
  parseVersion,
  runPortableUpdateHelper,
  sha256File,
  validateManifest,
  waitForProcessExit,
  writeDownload,
  writeStartupMarker,
};
