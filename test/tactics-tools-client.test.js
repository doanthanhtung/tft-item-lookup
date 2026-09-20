const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildUnitDetailUrl,
  createTacticsToolsClient,
  ITEM_DATA_URL,
  normalizeUnitData,
  parseNextData,
  parseUnitCatalog,
  stableQueryKey,
} = require('../electron/tactics-tools-client');

test('parses unit catalog and decodes HTML entities', () => {
  const html = '<a href="/vie/units/da_18_reksai"><div class="text-base">Rek&#x27;Sai</div></a><a href="/vie/units/da_18_reksai"><div class="text-base">Duplicate</div></a>';
  assert.deepEqual(parseUnitCatalog(html), [{ id: 'da_18_reksai', name: "Rek'Sai" }]);
});

test('builds stable detail URLs from observed route segments', () => {
  assert.equal(buildUnitDetailUrl({ unitId: 'da_18_lux_inferno', patch: '18.2b', rankGroup: 1, gameMode: 'ranked' }), 'https://tactics.tools/vie/units/da_18_lux_inferno/18.2b');
  assert.equal(buildUnitDetailUrl({ unitId: 'da_18_lux_inferno', patch: '18.2b', rankGroup: 2, gameMode: 'duo' }), 'https://tactics.tools/vie/units/da_18_lux_inferno/duo/18.2b/plat');
});

test('query key is independent from object property order', () => {
  const first = stableQueryKey({ unitId: 'lux', patch: '18.2b', rankGroup: 1, gameMode: 'ranked' });
  const second = stableQueryKey({ gameMode: 'ranked', rankGroup: 1, patch: '18.2b', unitId: 'lux' });
  assert.equal(first, second);
});

test('normalizes item, pair and trio stats with calculated play rate', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'unit-detail-lux.json'), 'utf8'));
  const result = normalizeUnitData(fixture, { items: { SpearOfShojin: 'Spear of Shojin', JeweledGauntlet: 'Jeweled Gauntlet', StrikersFlail: 'Strikers Flail' } });
  assert.equal(result.summary.games, 1000);
  assert.equal(result.items[0].playRate, 25);
  assert.deepEqual(result.pairs[0].items, ['Spear of Shojin', 'Jeweled Gauntlet']);
  assert.equal(result.pairs[0].delta, -0.2);
  assert.equal(result.trios[0].games, 50);
});

test('parses localized numeric strings without confusing thousands and decimals', () => {
  const result = normalizeUnitData({ unitData: {
    base: { count: '1,234', place: '3,4', top4: '68,06', won: '31,24' },
    items: [{ items: 'A', count: '1,000', place: '3,2', top4: '70,5', won: '30,25' }],
    itemPairs: [], itemTrios: [],
  } });
  assert.equal(result.summary.games, 1234);
  assert.equal(result.summary.avgPlace, 3.4);
  assert.equal(result.items[0].games, 1000);
  assert.equal(result.items[0].top4Rate, 70.5);
});

test('rejects missing Next.js data', () => {
  assert.throws(() => parseNextData('<html></html>'), (error) => error.code === 'SCHEMA_CHANGED');
});

test('queries a detail page, resolves item names and rate-limits the static data request', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'unit-detail-lux.json'), 'utf8'));
  const detailHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: fixture } })}</script>`;
  const staticText = 'window.data18=JSON.parse(`{"items":{"SpearOfShojin":"Spear of Shojin","JeweledGauntlet":"Jeweled Gauntlet","StrikersFlail":"Strikers Flail"}}`);';
  const requests = [];
  const sleeps = [];
  const client = createTacticsToolsClient({
    requestText: async (url) => { requests.push(url); return url === ITEM_DATA_URL ? staticText : detailHtml; },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  const result = await client.queryExplorer({ unitId: fixture.unitId, patch: '18.2b', rankGroup: 1, gameMode: 'ranked' });
  assert.equal(result.sourceUrl, 'https://tactics.tools/vie/units/da_18_lux_inferno/18.2b');
  assert.equal(result.trios[0].items[2], 'Strikers Flail');
  assert.equal(requests.length, 2);
  assert.ok(sleeps.some((milliseconds) => milliseconds >= 900));
});

test('uses Chromium fallback for a failed detail request', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'unit-detail-lux.json'), 'utf8'));
  const detailHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: fixture } })}</script>`;
  const staticText = 'window.data18=JSON.parse(`{"items":{}}`);';
  let fallbackCalls = 0;
  const client = createTacticsToolsClient({
    requestText: async (url) => {
      if (url === ITEM_DATA_URL) return staticText;
      throw Object.assign(new Error('network down'), { code: 'NETWORK' });
    },
    browserFallback: async () => { fallbackCalls += 1; return detailHtml; },
    sleep: async () => {},
  });
  const result = await client.queryExplorer({ unitId: fixture.unitId });
  assert.equal(result.summary.games, 1000);
  assert.equal(fallbackCalls, 1);
});

test('fails loudly for Patreon-only pages and malformed required fields', async () => {
  const client = createTacticsToolsClient({ requestText: async () => '<p>This is a Patreon only feature</p>', sleep: async () => {} });
  await assert.rejects(() => client.queryExplorer({ unitId: 'da_18_lux_inferno' }), (error) => error.code === 'PATREON_REQUIRED');
  assert.throws(() => normalizeUnitData({ unitData: { base: { count: 10, place: 3, top4: 70, won: 20 }, items: [{ items: 'A', count: 2, place: 3, top4: 'bad', won: 20 }] } }), (error) => error.code === 'SCHEMA_CHANGED');
});
