const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateManager, getFeedConfig } = require('../electron/update-manager');

class FakeUpdater extends EventEmitter {
  setFeedURL(config) { this.feedConfig = config; }
  async checkForUpdates() { this.emit('checking-for-update'); this.emit('update-available', { version: '0.2.0' }); }
  async downloadUpdate() { this.emit('download-progress', { percent: 42 }); this.emit('update-downloaded', { version: '0.2.0' }); }
  quitAndInstall() { this.installed = true; }
}

test('validates GitHub and generic update feed configuration', () => {
  assert.deepEqual(getFeedConfig({ provider: 'github', owner: 'doant', repo: 'tft-item-lookup' }), { provider: 'github', owner: 'doant', repo: 'tft-item-lookup', private: false });
  assert.deepEqual(getFeedConfig({ provider: 'generic', url: 'https://updates.example.com/tft/' }), { provider: 'generic', url: 'https://updates.example.com/tft/' });
  assert.equal(getFeedConfig({ provider: 'generic', url: 'http://updates.example.com' }), null);
  assert.equal(getFeedConfig({ provider: 'github', owner: '', repo: '' }), null);
});

test('keeps updater disabled in development builds', async () => {
  const updater = new FakeUpdater();
  const manager = createUpdateManager({ updater, isPackaged: false, config: { enabled: true, provider: 'github', owner: 'a', repo: 'b' } });
  assert.equal(manager.isEnabled(), false);
  assert.equal((await manager.checkForUpdates()).status, 'disabled');
  assert.equal(updater.feedConfig, undefined);
});

test('checks, downloads and installs an enabled update', async () => {
  const updater = new FakeUpdater();
  const statuses = [];
  const manager = createUpdateManager({
    updater,
    isPackaged: true,
    platform: 'win32',
    config: { enabled: true, provider: 'github', owner: 'doant', repo: 'tft-item-lookup' },
    onStatus: (status) => statuses.push(status.status),
  });
  assert.deepEqual(updater.feedConfig, { provider: 'github', owner: 'doant', repo: 'tft-item-lookup', private: false });
  await manager.checkForUpdates();
  assert.equal(manager.getState().status, 'available');
  await manager.downloadUpdate();
  assert.equal(manager.getState().status, 'downloaded');
  manager.installUpdate();
  assert.equal(updater.installed, true);
  assert.deepEqual(statuses, ['checking', 'available', 'downloading', 'downloading', 'downloaded']);
});
