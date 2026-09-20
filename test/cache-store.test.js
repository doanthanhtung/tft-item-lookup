const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCacheStore } = require('../electron/cache-store');

test('cache reports fresh and stale entries and persists to disk', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tft-item-lookup-'));
  const filePath = path.join(directory, 'cache.json');
  const store = createCacheStore(filePath, 10);
  await store.set('key', { answer: 42 });
  const fresh = await store.get('key');
  assert.equal(fresh.fresh, true);
  assert.deepEqual(fresh.value, { answer: 42 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stale = await store.get('key');
  assert.equal(stale.fresh, false);
  const reopened = createCacheStore(filePath, 10);
  assert.deepEqual((await reopened.get('key')).value, { answer: 42 });
  await fs.rm(directory, { recursive: true, force: true });
});

test('ignores a corrupted cache file instead of blocking startup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tft-item-lookup-corrupt-'));
  const filePath = path.join(directory, 'cache.json');
  await fs.writeFile(filePath, '{not-json', 'utf8');
  const store = createCacheStore(filePath);
  assert.equal(await store.get('missing'), null);
  await fs.rm(directory, { recursive: true, force: true });
});
