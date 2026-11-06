// PranIQ engine 3.1: runs the extension's background code in Node vm contexts.
// createEngine(keys, persist) creates an isolated engine per user.
// Shared disk cache caches YouTube search results (24h) and stats (6h).
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');

const DATA = process.env.PRANIQ_DATA || path.join(__dirname, 'praniq-data.json');
const CACHE_FILE = process.env.PRANIQ_CACHE || path.join(__dirname, 'praniq-cache.json');

// Shared disk cache for public YouTube search results and video/channel stats
let diskCache = {};
try { diskCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
let cacheDirty = false;
const flushCache = () => {
  if (!cacheDirty) return;
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(diskCache));
    cacheDirty = false;
  } catch {}
};
process.on('exit', flushCache);

const diskCacheApi = {
  get: (k) => {
    const entry = diskCache[k];
    if (!entry) return null;
    if (entry.exp && Date.now() > entry.exp) {
      delete diskCache[k];
      cacheDirty = true;
      return null;
    }
    return entry.val;
  },
  set: (k, val, ttl) => {
    diskCache[k] = { val, exp: Date.now() + ttl, t: Date.now() };
    cacheDirty = true;
    flushCache();
  },
  stats: () => {
    const now = Date.now();
    let total = 0, search = 0, stats = 0;
    for (const [k, v] of Object.entries(diskCache)) {
      if (v.exp && now > v.exp) continue;
      total++;
      if (k.includes('/search?')) search++;
      else stats++;
    }
    return { total, search, stats };
  }
};

// Pre-compile scripts once with vm.Script for speed across all contexts
const utilsCode = fs.readFileSync(path.join(__dirname, 'engine', 'utils.js'), 'utf8');
const bgCode = fs.readFileSync(path.join(__dirname, 'engine', 'background.js'), 'utf8') +
  '\n;self.__H = handlers; self.__getActiveQuotaWarning = (typeof getActiveQuotaWarning === "function") ? getActiveQuotaWarning : null;';
const bgAutoCode = fs.readFileSync(path.join(__dirname, 'engine', 'bg-auto.js'), 'utf8');

const utilsScript = new vm.Script(utilsCode, { filename: 'utils.js' });
const bgScript = new vm.Script(bgCode, { filename: 'background.js' });
const bgAutoScript = new vm.Script(bgAutoCode, { filename: 'bg-auto.js' });

const ERR = {
  NO_KEY: 'NEEDS_YOUTUBE_KEY',
  NO_AI: 'NEEDS_GEMINI_KEY',
  NEEDS_YOUTUBE_KEY: 'NEEDS_YOUTUBE_KEY',
  NEEDS_GEMINI_KEY: 'NEEDS_GEMINI_KEY'
};

function createEngine(keys = {}, persist = false) {
  let local = {};
  if (persist) {
    try { local = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
  }
  const save = () => {
    if (!persist) return;
    try { fs.writeFileSync(DATA, JSON.stringify(local, null, 2)); } catch {}
  };

  const sync = {
    apiKey: (keys && (keys.youtube || keys.apiKey)) || '',
    geminiKey: (keys && (keys.gemini || keys.geminiKey)) || '',
    geminiModel: (keys && keys.model) || process.env.GEMINI_MODEL || ''
  };

  const area = (o, shouldPersist) => ({
    get: async (k) => {
      const r = {};
      (k == null ? Object.keys(o) : [].concat(k)).forEach((x) => { if (x in o) r[x] = o[x]; });
      return r;
    },
    set: async (v) => {
      Object.assign(o, v);
      if (shouldPersist) save();
    },
    remove: async (k) => {
      [].concat(k).forEach((x) => delete o[x]);
      if (shouldPersist) save();
    }
  });

  const noop = () => {};
  const ev = { addListener: noop };

  const ctx = {
    console, URL, URLSearchParams, Date, Promise, Set, Map, JSON, Math, Array, Object, String, Number, RegExp, Error,
    setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, fetch, TextDecoder, Uint8Array, ArrayBuffer,
    Buffer, crypto,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    chrome: {
      storage: {
        sync: area(sync, false),
        local: area(local, persist),
        onChanged: ev
      },
      runtime: { onMessage: ev, onInstalled: ev, openOptionsPage: noop },
      alarms: { create: noop, clear: noop, onAlarm: ev },
      notifications: { create: noop, onClicked: ev },
      tabs: { create: noop },
      action: {}
    },
    __diskCache: diskCacheApi
  };

  ctx.self = ctx;
  ctx.globalThis = ctx;

  const scriptsMap = {
    'utils.js': utilsScript,
    'bg-auto.js': bgAutoScript
  };

  ctx.importScripts = (...files) => {
    files.forEach((f) => {
      if (scriptsMap[f]) {
        scriptsMap[f].runInContext(ctx);
      } else {
        vm.runInContext(fs.readFileSync(path.join(__dirname, 'engine', f), 'utf8'), ctx, { filename: f });
      }
    });
  };

  vm.createContext(ctx);
  bgScript.runInContext(ctx);

  const H = ctx.__H;
  const getWarning = ctx.__getActiveQuotaWarning;

  async function call(name, args = {}) {
    if (!H[name]) throw new Error('Unknown tool ' + name);
    let res;
    try {
      res = await H[name](args);
    } catch (e) {
      const code = ERR[e.message] || e.message;
      throw new Error(code);
    }
    if (name !== 'keyStatus' && name !== 'start_here' && getWarning) {
      try {
        const warn = await getWarning();
        if (warn && res && typeof res === 'object' && !Array.isArray(res)) {
          res._quotaWarning = warn;
        }
      } catch {}
    }
    return res;
  }

  return { call, H, ctx };
}

const envKeys = {
  youtube: process.env.YOUTUBE_API_KEYS || process.env.YOUTUBE_API_KEY || '',
  gemini: process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || ''
};

// Shared default engine using environment variables (only this one saves to the data file)
const defaultEngine = createEngine(envKeys, true);

module.exports = {
  createEngine,
  call: defaultEngine.call,
  H: defaultEngine.H,
  defaultEngine,
  envKeys,
  flushCache
};
