const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const {
  MAX_UPDATE_BYTES,
  compareVersions,
  createPortableUpdateManager,
  getManifestUrl,
  runPortableUpdateHelper,
  validateManifest,
  writeDownload,
} = require('../electron/update-manager');

const config = {
  enabled: true,
  distribution: 'portable',
  owner: 'doanthanhtung',
  repo: 'tft-item-lookup',
  manifestUrl: 'https://github.com/doanthanhtung/tft-item-lookup/releases/latest/download/latest.json',
};

function manifest(version = '0.1.2', payload = 'portable-update') {
  const bytes = Buffer.from(payload);
  return {
    schemaVersion: 1,
    version,
    platform: 'win32-x64',
    assetName: 'TFT-Item-Lookup-' + version + '-portable.exe',
    downloadUrl: 'https://github.com/doanthanhtung/tft-item-lookup/releases/download/v' + version + '/TFT-Item-Lookup-' + version + '-portable.exe',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    releaseUrl: 'https://github.com/doanthanhtung/tft-item-lookup/releases/tag/v' + version,
  };
}

function responseFrom(value, status = 200) {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === 'content-length' ? String(body.length) : null },
    body: Readable.toWeb(Readable.from([body])),
    async json() { return JSON.parse(body.toString('utf8')); },
  };
}

test('compares semantic versions and rejects invalid versions', () => {
  assert.equal(compareVersions('0.1.2', '0.1.1'), 1);
  assert.equal(compareVersions('0.1.1', '0.1.1'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.throws(() => compareVersions('latest', '0.1.0'), /Version không hợp lệ/);
});

test('validates manifest schema, repository URL and artifact name', () => {
  const valid = validateManifest(manifest(), { config, currentVersion: '0.1.1' });
  assert.equal(valid.isNewer, true);
  assert.equal(valid.assetName, 'TFT-Item-Lookup-0.1.2-portable.exe');
  assert.equal(getManifestUrl(config), config.manifestUrl);
  assert.throws(() => validateManifest({ ...manifest(), downloadUrl: 'https://evil.example/update.exe' }, { config, currentVersion: '0.1.1' }), /URL download/);
  assert.throws(() => validateManifest({ ...manifest(), assetName: 'other.exe' }, { config, currentVersion: '0.1.1' }), /Artifact/);
  assert.throws(() => validateManifest({ ...manifest(), sha256: 'bad' }, { config, currentVersion: '0.1.1' }), /SHA-256/);
  assert.throws(() => validateManifest({ ...manifest(), size: MAX_UPDATE_BYTES + 1 }, { config, currentVersion: '0.1.1' }), /Kích thước/);
});

test('does not offer a downgrade or the current version', () => {
  assert.equal(validateManifest(manifest('0.1.1'), { config, currentVersion: '0.1.1' }).isNewer, false);
  assert.equal(validateManifest(manifest('0.1.0'), { config, currentVersion: '0.1.1' }).isNewer, false);
});

test('downloads by stream, reports progress and returns SHA-256', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'tft-update-download-'));
  const destination = path.join(directory, 'update.exe');
  const payload = 'portable-payload';
  const progress = [];
  const result = await writeDownload(async () => responseFrom(payload), 'https://github.com/example/update.exe', destination, {
    expectedSize: Buffer.byteLength(payload),
    onProgress: (value) => progress.push(value),
  });
  assert.equal(result.bytes, Buffer.byteLength(payload));
  assert.equal(result.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
  assert.ok(progress.at(-1) >= 100);
  await fsp.rm(directory, { recursive: true, force: true });
});

test('manager checks latest manifest and transitions to available', async () => {
  const statuses = [];
  const updateManifest = manifest();
  const manager = createPortableUpdateManager({
    app: { getPath: () => os.tmpdir() },
    config,
    currentVersion: '0.1.1',
    isPackaged: true,
    platform: 'win32',
    portableExecutableFile: 'C:\Apps\TFT-Item-Lookup.exe',
    fetchImpl: async () => responseFrom(updateManifest),
    onStatus: (state) => statuses.push(state.status),
  });
  const result = await manager.checkForUpdates();
  assert.equal(result.status, 'available');
  assert.equal(result.availableVersion, '0.1.2');
  assert.deepEqual(statuses, ['checking', 'available']);
});

test('manager reports no update and common HTTP errors without throwing', async () => {
  const latest = createPortableUpdateManager({
    config,
    currentVersion: '0.1.2',
    isPackaged: true,
    platform: 'win32',
    portableExecutableFile: 'C:\Apps\TFT-Item-Lookup.exe',
    fetchImpl: async () => responseFrom(manifest('0.1.2')),
  });
  assert.equal((await latest.checkForUpdates()).status, 'not-available');

  for (const statusCode of [403, 404, 429, 500, 503]) {
    const failed = createPortableUpdateManager({
      config,
      currentVersion: '0.1.1',
      isPackaged: true,
      platform: 'win32',
      portableExecutableFile: 'C:\Apps\TFT-Item-Lookup.exe',
      fetchImpl: async () => responseFrom({}, statusCode),
    });
    const state = await failed.checkForUpdates();
    assert.equal(state.status, 'error');
    assert.match(state.error, new RegExp('HTTP ' + statusCode));
  }
});

test('manager rejects malformed JSON and a downloaded hash mismatch', async () => {
  const malformed = createPortableUpdateManager({
    config,
    currentVersion: '0.1.1',
    isPackaged: true,
    platform: 'win32',
    portableExecutableFile: 'C:\Apps\TFT-Item-Lookup.exe',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token'); } }),
  });
  assert.equal((await malformed.checkForUpdates()).status, 'error');

  const badManifest = { ...manifest(), sha256: '0'.repeat(64) };
  let spawned = false;
  const mismatch = createPortableUpdateManager({
    app: { getPath: () => os.tmpdir() },
    config,
    currentVersion: '0.1.1',
    isPackaged: true,
    platform: 'win32',
    portableExecutableFile: 'C:\Apps\TFT-Item-Lookup.exe',
    fetchImpl: async (url) => url.endsWith('latest.json') ? responseFrom(badManifest) : responseFrom('portable-update'),
    spawnImpl: () => { spawned = true; return { unref() {} }; },
  });
  await mismatch.checkForUpdates();
  const state = await mismatch.downloadAndInstall();
  assert.equal(state.status, 'error');
  assert.equal(spawned, false);
});

test('portable updater stays disabled in development or without executable path', () => {
  const development = createPortableUpdateManager({ config, isPackaged: false });
  assert.equal(development.isEnabled(), false);
  assert.equal(development.getState().status, 'disabled');

  const missingPath = createPortableUpdateManager({ config, isPackaged: true, platform: 'win32', portableExecutableFile: '' });
  assert.equal(missingPath.isEnabled(), false);
  assert.equal(missingPath.getState().status, 'error');
});

test('downloads, verifies and schedules a portable installation', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'tft-update-manager-'));
  const payload = 'portable-update';
  const updateManifest = manifest('0.1.2', payload);
  let spawned;
  let quitRequested = false;
  const manager = createPortableUpdateManager({
    app: { getPath: () => directory },
    config,
    currentVersion: '0.1.1',
    isPackaged: true,
    platform: 'win32',
    portableExecutableFile: path.join(directory, 'TFT-Item-Lookup.exe'),
    execPath: path.join(directory, 'runtime.exe'),
    fetchImpl: async (url) => url.endsWith('latest.json') ? responseFrom(updateManifest) : responseFrom(payload),
    spawnImpl: (file, args) => {
      spawned = { file, args };
      return { unref() {} };
    },
    onInstallRequested: () => { quitRequested = true; },
  });
  await manager.checkForUpdates();
  const state = await manager.downloadAndInstall();
  assert.equal(state.status, 'installing');
  assert.equal(quitRequested, true);
  assert.equal(spawned.args[0], '--tft-update-helper');
  assert.ok(fs.existsSync(spawned.args[1]));
  await fsp.rm(directory, { recursive: true, force: true });
});

test('helper atomically replaces the executable and cleans temporary files', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'tft-update-helper-'));
  const appDirectory = path.join(directory, 'Thư mục app có dấu cách');
  await fsp.mkdir(appDirectory);
  const targetPath = path.join(appDirectory, 'TFT-Item-Lookup.exe');
  const stagedPath = path.join(directory, 'download.exe');
  const jobPath = path.join(directory, 'job.json');
  const markerPath = path.join(directory, 'started.json');
  await fsp.writeFile(targetPath, 'old');
  await fsp.writeFile(stagedPath, 'new');
  const hash = crypto.createHash('sha256').update('new').digest('hex');
  await fsp.writeFile(jobPath, JSON.stringify({ targetPath, stagedPath, markerPath, parentPid: 999999, sha256: hash }));
  await runPortableUpdateHelper(jobPath, {
    processExistsImpl: () => false,
    spawnImpl: (_file, _args, options) => {
      fs.writeFileSync(options.env.TFT_UPDATE_SUCCESS_MARKER, 'ok');
      return { pid: 1, unref() {} };
    },
    startupTimeoutMs: 100,
    startupPollIntervalMs: 1,
  });
  assert.equal(await fsp.readFile(targetPath, 'utf8'), 'new');
  assert.equal(fs.existsSync(jobPath), false);
  assert.equal(fs.existsSync(stagedPath), false);
  await fsp.rm(directory, { recursive: true, force: true });
});

test('helper rolls back when the new process does not signal startup', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'tft-update-rollback-'));
  const targetPath = path.join(directory, 'TFT-Item-Lookup.exe');
  const stagedPath = path.join(directory, 'download.exe');
  const jobPath = path.join(directory, 'job.json');
  const markerPath = path.join(directory, 'started.json');
  await fsp.writeFile(targetPath, 'old');
  await fsp.writeFile(stagedPath, 'new');
  const hash = crypto.createHash('sha256').update('new').digest('hex');
  await fsp.writeFile(jobPath, JSON.stringify({ targetPath, stagedPath, markerPath, parentPid: 999999, sha256: hash }));
  await assert.rejects(() => runPortableUpdateHelper(jobPath, {
    processExistsImpl: () => false,
    spawnImpl: () => ({ pid: 1, unref() {} }),
    killProcessImpl: () => {},
    startupTimeoutMs: 5,
    startupPollIntervalMs: 1,
    logger: { error() {} },
  }), /khởi động thành công/);
  assert.equal(await fsp.readFile(targetPath, 'utf8'), 'old');
  await fsp.rm(directory, { recursive: true, force: true });
});
