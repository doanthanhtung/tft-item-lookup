const crypto = require('node:crypto');
const https = require('node:https');

const SITE_BASE = 'https://tactics.tools';
const UNIT_LIST_URL = `${SITE_BASE}/vie/units`;
const ITEM_DATA_URL = 'https://ap.tft.tools/static/s18/data.js';
const USER_AGENT = 'TFT-Item-Lookup/0.1 (personal research; respectful rate limit)';

const RANK_SEGMENTS = {
  0: 'top',
  1: '',
  2: 'plat',
  3: 'all',
  4: 'gm',
};

function decodeHtml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeSlug(value) {
  const slug = String(value || '').trim();
  if (!/^[a-z0-9_-]+$/i.test(slug)) throw new Error('Unit ID không hợp lệ.');
  return slug;
}

function parseUnitCatalog(html) {
  const units = [];
  const seen = new Set();
  const pattern = /<a[^>]+href="\/vie\/units\/([^"?#]+)"[\s\S]*?<div class="text-base[^>]*>([^<]+)<\/div>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const id = decodeHtml(match[1]);
    if (seen.has(id)) continue;
    seen.add(id);
    units.push({ id, name: decodeHtml(match[2]).trim() });
  }
  return units;
}

function parseNextData(html) {
  const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw Object.assign(new Error('Không tìm thấy dữ liệu Next.js.'), { code: 'SCHEMA_CHANGED' });
  try { return JSON.parse(match[1]); }
  catch { throw Object.assign(new Error('Dữ liệu Next.js không hợp lệ.'), { code: 'SCHEMA_CHANGED' }); }
}

function normalizeQueryFilters(filters = {}) {
  const normalized = {
    unitId: normalizeSlug(filters.unitId),
    patch: String(filters.patch || '').trim(),
    rankGroup: Number.isInteger(Number(filters.rankGroup)) ? Number(filters.rankGroup) : 1,
    gameMode: ['ranked', 'duo', 'hyperroll'].includes(filters.gameMode) ? filters.gameMode : 'ranked',
    region: String(filters.region || 'all'),
    level: String(filters.level || 'all'),
    itemCount: String(filters.itemCount || 'all'),
    lastRound: String(filters.lastRound || 'all'),
    date: String(filters.date || 'all'),
    minSample: Math.max(0, Number(filters.minSample) || 0),
  };
  if (!(normalized.rankGroup in RANK_SEGMENTS)) normalized.rankGroup = 1;
  return normalized;
}

function stableQueryKey(filters) {
  const normalized = normalizeQueryFilters(filters);
  const serialized = JSON.stringify(Object.keys(normalized).sort().reduce((result, key) => {
    result[key] = normalized[key];
    return result;
  }, {}));
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function buildUnitDetailUrl(filters, locale = 'vie') {
  const normalized = normalizeQueryFilters(filters);
  const segments = [];
  if (normalized.gameMode === 'duo') segments.push('duo');
  if (normalized.gameMode === 'hyperroll') segments.push('hr');
  if (normalized.patch) segments.push(encodeURIComponent(normalized.patch));
  const rankSegment = RANK_SEGMENTS[normalized.rankGroup];
  if (rankSegment) segments.push(rankSegment);
  return `${SITE_BASE}/${locale}/units/${normalized.unitId}${segments.length ? `/${segments.join('/')}` : ''}`;
}

function parseNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let text = String(value ?? '').replace('%', '').replace(/\s/g, '').trim();
  if (text.includes(',') && text.includes('.')) text = text.replace(/,/g, '');
  else if (/^-?\d{1,3}(,\d{3})+$/.test(text)) text = text.replace(/,/g, '');
  else text = text.replace(',', '.');
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = parseNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireNumber(value, fieldName) {
  const parsed = parseOptionalNumber(value);
  if (parsed === null) {
    throw Object.assign(new Error(`Trường ${fieldName} trong response không hợp lệ.`), { code: 'SCHEMA_CHANGED' });
  }
  return parsed;
}

function prettifyItemId(itemId) {
  return String(itemId || '')
    .replace(/^DA_/, '')
    .replace(/^TFT\d+_/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim() || 'Không rõ';
}

function extractStaticData(text) {
  const match = text.match(/window\.data18\s*=\s*JSON\.parse\(`([\s\S]*)`\)\s*;?/);
  if (!match) throw Object.assign(new Error('Không đọc được dữ liệu tĩnh item.'), { code: 'SCHEMA_CHANGED' });
  try { return JSON.parse(match[1]); }
  catch { throw Object.assign(new Error('Dữ liệu tĩnh item không hợp lệ.'), { code: 'SCHEMA_CHANGED' }); }
}

function createItemNameResolver(staticData = {}) {
  const names = new Map();
  for (const [key, value] of Object.entries(staticData.items || {})) {
    const name = typeof value === 'string' ? value : value?.name || value?.displayName || key;
    for (const alias of [key, `DA_${key}`, `TFT18_${key}`]) names.set(alias.toLowerCase(), decodeHtml(name));
  }
  return (itemId) => names.get(String(itemId).toLowerCase()) || prettifyItemId(itemId);
}

function normalizeRows(rows, totalGames, resolveName) {
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) throw Object.assign(new Error('Danh sách item trong response không hợp lệ.'), { code: 'SCHEMA_CHANGED' });
  return rows.map((row) => {
    if (!row || typeof row !== 'object') throw Object.assign(new Error('Một dòng item trong response không hợp lệ.'), { code: 'SCHEMA_CHANGED' });
    const itemIds = Array.isArray(row.items) ? row.items : [row.items];
    if (!itemIds.length || itemIds.some((itemId) => typeof itemId !== 'string' || !itemId.trim())) {
      throw Object.assign(new Error('Thiếu ID item trong response.'), { code: 'SCHEMA_CHANGED' });
    }
    const games = Math.max(0, requireNumber(row.count, 'count'));
    return {
      itemIds,
      items: itemIds.map(resolveName),
      games,
      playRate: totalGames > 0 ? (games / totalGames) * 100 : 0,
      avgPlace: requireNumber(row.place, 'place'),
      top4Rate: requireNumber(row.top4, 'top4'),
      winRate: requireNumber(row.won, 'won'),
      delta: parseOptionalNumber(row.adjDelta),
    };
  });
}

function normalizeUnitData(pageProps, staticData = {}) {
  const unitData = pageProps?.unitData;
  if (!unitData || !unitData.base) throw Object.assign(new Error('Nguồn không trả về unitData hợp lệ.'), { code: 'SCHEMA_CHANGED' });
  const totalGames = Math.max(0, requireNumber(unitData.base.count, 'base.count'));
  const resolveName = createItemNameResolver(staticData);
  return {
    unitId: pageProps.unitId || unitData.unitId,
    starLevel: pageProps.starLevel || unitData.starLevel || null,
    aperture: pageProps.aperture || null,
    summary: {
      games: totalGames,
      playRate: parseOptionalNumber(unitData.base.rate),
      avgPlace: requireNumber(unitData.base.place, 'base.place'),
      top4Rate: requireNumber(unitData.base.top4, 'base.top4'),
      winRate: requireNumber(unitData.base.won, 'base.won'),
      avgLevel: parseOptionalNumber(unitData.base.avgLevel),
    },
    items: normalizeRows(unitData.items, totalGames, resolveName),
    pairs: normalizeRows(unitData.itemPairs, totalGames, resolveName),
    trios: normalizeRows(unitData.itemTrios, totalGames, resolveName),
  };
}

function fetchText(url, { timeoutMs = 20000 } = {}) {
  if (!url.startsWith(`${SITE_BASE}/`) && url !== ITEM_DATA_URL) throw new Error('URL ngoài danh sách nguồn được phép.');
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json' } }, (response) => {
      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = chunks.join('');
        if (response.statusCode !== 200) {
          const error = new Error(`Nguồn trả về HTTP ${response.statusCode}.`);
          error.code = response.statusCode === 403 ? 'FORBIDDEN' : response.statusCode === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR';
          error.statusCode = response.statusCode;
          reject(error);
          return;
        }
        resolve(body);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('Hết thời gian kết nối.'), { code: 'NETWORK' })));
    request.on('error', reject);
  });
}

function createTacticsToolsClient({ browserFallback, requestText = fetchText, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let lastRequestAt = 0;
  let staticDataPromise;

  async function limitedFetch(url, { useBrowserFallback = true } = {}) {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < 1000) await sleep(1000 - elapsed);
    lastRequestAt = Date.now();
    try { return await requestText(url); }
    catch (error) {
      if (!useBrowserFallback || !browserFallback || !['NETWORK', 'FORBIDDEN', 'HTTP_ERROR'].includes(error.code)) throw error;
      return browserFallback(url);
    }
  }

  async function getStaticData() {
    if (!staticDataPromise) staticDataPromise = limitedFetch(ITEM_DATA_URL, { useBrowserFallback: false }).then(extractStaticData);
    return staticDataPromise;
  }

  return {
    async getUnitCatalog() {
      const html = await limitedFetch(UNIT_LIST_URL);
      const units = parseUnitCatalog(html);
      if (!units.length) throw Object.assign(new Error('Không tìm thấy danh sách tướng.'), { code: 'SCHEMA_CHANGED' });
      return { units, sourceUrl: UNIT_LIST_URL, fetchedAt: Date.now() };
    },
    async queryExplorer(filters) {
      const normalized = normalizeQueryFilters(filters);
      const sourceUrl = buildUnitDetailUrl(normalized);
      const html = await limitedFetch(sourceUrl);
      if (/This is a Patreon only feature|Patreon only feature/i.test(html)) {
        throw Object.assign(new Error('Nguồn yêu cầu Patreon cho Explorer nâng cao.'), { code: 'PATREON_REQUIRED' });
      }
      const nextData = parseNextData(html);
      const staticData = await getStaticData();
      return { ...normalizeUnitData(nextData.props?.pageProps, staticData), filters: normalized, sourceUrl, fetchedAt: Date.now() };
    },
    normalizeItemStats: (data) => data?.items || [],
    normalizeBuildStats: (data) => data?.trios || data?.pairs || [],
  };
}

module.exports = {
  SITE_BASE,
  UNIT_LIST_URL,
  ITEM_DATA_URL,
  decodeHtml,
  normalizeSlug,
  parseUnitCatalog,
  parseNextData,
  normalizeQueryFilters,
  stableQueryKey,
  buildUnitDetailUrl,
  extractStaticData,
  normalizeUnitData,
  createTacticsToolsClient,
};
