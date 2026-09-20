const fs = require('node:fs/promises');
const path = require('node:path');

function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

function createCacheStore(filePath, ttlMs = 15 * 60 * 1000) {
  let loaded;

  async function readFile() {
    if (!loaded) {
      loaded = fs.readFile(filePath, 'utf8')
        .then((text) => JSON.parse(text))
        .catch((error) => {
          if (error.code === 'ENOENT') return {};
          if (error instanceof SyntaxError) return {};
          throw error;
        });
    }
    return loaded;
  }

  async function writeFile(data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tempPath, filePath);
    loaded = Promise.resolve(data);
  }

  return {
    async get(key) {
      const data = await readFile();
      const entry = data[key];
      if (!entry || !entry.fetchedAt) return null;
      const ageMs = Date.now() - entry.fetchedAt;
      return { ...entry, fresh: ageMs <= ttlMs, ageMs };
    },
    async set(key, value, metadata = {}) {
      const data = await readFile();
      data[key] = { value, fetchedAt: Date.now(), ...metadata };
      await writeFile(data);
      return data[key];
    },
    async clear() {
      loaded = Promise.resolve({});
      try { await fs.unlink(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}

module.exports = { createCacheStore, stableSerialize };
