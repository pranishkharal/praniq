#!/usr/bin/env node
// PranIQ MCP server 3.2.0 · made by Pranish Kharal · WhatsApp +977 9700720101
// stdio:  node server.js            (no keys? a key page opens on http://127.0.0.1:3335)
// http:   node server.js --http     (PORT env, default 3333)
//   PRANIQ_USER_KEYS_ONLY=1  public server: every user connects their own keys on the secure key page
//   PRANIQ_SECRET            long random text; keeps personal links working after restarts
//   PRANIQ_TOKEN             (private mode only) require "Authorization: Bearer <token>"
//   PUBLIC_URL               your server's https address (auto-detected on Render)
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const crypto = require('crypto');
const { createEngine, envKeys } = require('./engine');
const K = require('./keys');
const page = require('./setup-page');

const PUBLIC = /^(1|true|yes)$/i.test(process.env.PRANIQ_USER_KEYS_ONLY || '');

const MAX = 60000;
const out = (d) => {
  let s = typeof d === 'string' ? d : JSON.stringify(d, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v), 2);
  if (s.length > MAX) s = s.slice(0, MAX) + '\n…(trimmed)';
  return { content: [{ type: 'text', text: s }] };
};
const errText = (e) => 'PranIQ error: ' + String((e && e.message) || e).replace(/PranIQ settings|settings/g, 'the PranIQ key page');
const aiText = (r) => (r && r.text ? r.text : r);

function vid(s) {
  s = String(s || '').trim();
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/);
  return m ? m[1] : s;
}

const TOOLS = [
  [
    'start_here',
    'Call this FIRST in every chat, before any other PranIQ tool. Checks that the user has connected their own YouTube (and optional Gemini) API keys. If not, gives a secure PranIQ link to enter them. Show that link to the user and wait until they say done, then call start_here again. Never ask for keys in chat.',
    {},
    null
  ],
  [
    'keyword_score',
    'Score a YouTube search keyword (0-100 score, search demand, competition level, and top 20 ranking videos). Uses 24-hour disk cache; costs ~100 YouTube API units on cache miss.',
    { keyword: z.string().describe('The search query or keyword phrase to analyze (e.g. "ai history", "finance for teens")') },
    (a, call) => call('keyword', { q: a.keyword })
  ],
  [
    'bulk_keywords',
    'Expand a seed keyword into dozens of high-value related YouTube searches (from YouTube autocomplete) ranked by popularity. 100% free, 0 API units used.',
    { seed: z.string().describe('Seed keyword or topic phrase (e.g. "stick man animation", "python tutorial")') },
    (a, call) => call('bulkKeywords', { q: a.seed })
  ],
  [
    'niche_finder',
    'Discover and evaluate profitable faceless/automation YouTube niches: surfaces small & recently launched channels getting high views, calculate go/no-go score, and estimate monthly earnings. Costs ~100 API units on cache miss (24h cached).',
    {
      niche: z.string().describe('Niche or topic keyword to check (e.g. "history animations", "stoicism", "space facts")'),
      max_channel_age_months: z.number().optional().describe('Filter channels newer than this many months (default 12)'),
      max_subs: z.number().optional().describe('Filter channels with fewer than this many subscribers (default 100,000)'),
      days: z.number().optional().describe('Search videos published within this many days (default 90)')
    },
    (a, call) => call('nicheFind', { q: a.niche, maxAgeMonths: a.max_channel_age_months, maxSubs: a.max_subs, days: a.days })
  ],
  [
    'outlier_videos',
    'Find viral outlier videos in a niche: videos that gained substantially more views than the channel normally gets. Ideal for winning topic ideation. Costs ~100 API units (24h cached).',
    {
      niche: z.string().describe('Niche or keyword to search for outlier videos'),
      days: z.number().optional().describe('Look back this many days (default 30)'),
      max_subs: z.number().optional().describe('Filter for channels under this subscriber count'),
      duration: z.enum(['any', 'short', 'medium', 'long']).optional().describe('Video duration: short (<4m), medium (4-20m), long (>20m)'),
      min_ratio: z.number().optional().describe('Minimum view-to-sub or view-to-median outlier multiplier (default 2.0x)')
    },
    (a, call) => call('outliers', { q: a.niche, days: a.days, maxSubs: a.max_subs, duration: a.duration, minRatio: a.min_ratio })
  ],
  [
    'channel_analysis',
    'Analyze any YouTube channel: subscriber & total view stats, monthly earnings estimate, upload frequency, and recent video performance with outlier scores. Cached for 6 hours.',
    { channel: z.string().describe('YouTube channel URL, @handle, channel ID (UC...), or channel name') },
    (a, call) => call('analyzeChannel', { input: a.channel })
  ],
  [
    'channel_growth',
    'Detailed channel growth breakdown: estimated views gained per day/week/month, historical upload pace, and top-performing videos. Cached for 6 hours.',
    { channel: z.string().describe('YouTube channel URL, @handle, channel ID, or channel name') },
    (a, call) => call('channelFull', { input: a.channel, max: 200 })
  ],
  [
    'compare_channels',
    'Compare 2 to 3 YouTube channels side-by-side on views, subscriber pace, engagement, and upload volume.',
    { channels: z.array(z.string()).min(2).max(3).describe('Array of 2 or 3 channel URLs, @handles, or IDs to compare') },
    (a, call) => call('compare', { inputs: a.channels })
  ],
  [
    'similar_channels',
    'Discover competitor channels similar to a given channel for audience overlap and niche mapping. Costs ~100 API units on cache miss.',
    { channel: z.string().describe('Base channel URL, @handle, channel ID, or name') },
    (a, call) => call('similar', { input: a.channel })
  ],
  [
    'video_analysis',
    'Comprehensive YouTube video analysis: views, views-per-hour (VPH), engagement rate, outlier multiplier, SEO tags, title length, and creator channel context. Cached for 6 hours.',
    { video: z.string().describe('YouTube video URL or 11-character video ID') },
    (a, call) => call('watchFull', { videoId: vid(a.video) })
  ],
  [
    'video_transcript',
    'Extract the complete caption transcript with timestamps and text from any YouTube video. Free, uses YouTube captions.',
    { video: z.string().describe('YouTube video URL or 11-character video ID') },
    (a, call) => call('transcript', { videoId: vid(a.video) })
  ],
  [
    'video_pack',
    'AI Video Production Pack: creates 5 high-CTR titles, hook, full word-by-word script, scene-by-scene breakdown with image generation prompts, SEO description, tags, pinned comment, music prompt, and Shorts spin-offs. Requires GEMINI_API_KEY.',
    {
      topic: z.string().optional().describe('The topic or concept to create a complete production pack for'),
      video: z.string().optional().describe('Or an existing YouTube video URL/ID to model the pack after'),
      minutes: z.number().optional().describe('Target video duration in minutes (default 8)'),
      style: z.string().optional().describe('Tone and style (e.g. "documentary", "suspenseful", "educational", "storytelling")'),
      shorts: z.boolean().optional().describe('Whether to generate companion Shorts concepts (default true)')
    },
    (a, call) => call('videoPack', { topic: a.topic, videoId: a.video ? vid(a.video) : undefined, minutes: a.minutes, style: a.style, shorts: a.shorts })
  ],
  [
    'rewrite_script',
    'AI Script Rewriter: reads an existing video\'s transcript and writes a completely original, engaging script with a fresh angle, avoiding copyright while retaining winning narrative structure. Requires GEMINI_API_KEY.',
    {
      video: z.string().describe('YouTube video URL or ID to pull transcript from'),
      angle: z.string().optional().describe('New perspective, hook angle, or focus for the rewritten script'),
      minutes: z.number().optional().describe('Target length in minutes (default matches source or 8m)')
    },
    (a, call) => call('rewriteScript', { videoId: vid(a.video), angle: a.angle, minutes: a.minutes }).then(aiText)
  ],
  [
    'shorts_clips',
    'AI Shorts Clip Finder: analyzes a video transcript to pinpoint the best 20-58 second viral moments with hook summaries and exact cut timestamps. Requires GEMINI_API_KEY.',
    { video: z.string().describe('YouTube video URL or ID') },
    (a, call) => call('shortsClips', { videoId: vid(a.video) })
  ],
  [
    'thumbnail_review',
    'AI Thumbnail Review: analyzes a video thumbnail image for visual hierarchy, mobile readability, contrast, emotional draw, clutter, and returns actionable improvement fixes. Requires GEMINI_API_KEY.',
    { video: z.string().describe('YouTube video URL or ID') },
    (a, call) => call('thumbAnalyze', { videoId: vid(a.video) })
  ],
  [
    'title_ideas_for_video',
    'AI Title Optimizer: remixes and suggests 10 high-CTR, curiosity-driven titles for an existing YouTube video. Requires GEMINI_API_KEY.',
    { video: z.string().describe('YouTube video URL or ID') },
    (a, call) => call('aiRemix', { videoId: vid(a.video) })
  ],
  [
    'ai_writer',
    'AI Creator Studio: specialized YouTube copywriter. Kinds: ideas, titles, hooks, description, tags, script, shorts, channel (new channel blueprint), calendar (30-day content plan), comment (pinned comment). Requires GEMINI_API_KEY.',
    {
      kind: z.enum(['ideas', 'titles', 'hooks', 'description', 'tags', 'script', 'shorts', 'channel', 'calendar', 'comment']).describe('Asset kind to write'),
      topic: z.string().describe('Topic, niche, or summary'),
      extra: z.string().optional().describe('Additional instructions, audience profile, or tone guidelines')
    },
    (a, call) => call('aiTool', { kind: a.kind, topic: a.topic, extra: a.extra }).then(aiText)
  ],
  [
    'api_key_status',
    'Inspect YouTube Data API and Gemini API health: shows active and resting keys, daily searches and units consumed per key (resetting at midnight PT), and disk cache statistics.',
    {},
    (a, call) => call('keyStatus').then((r) => {
      const ytTotal = (r.youtube && r.youtube.totalKeys) || 0;
      const aiTotal = (r.gemini && r.gemini.totalKeys) || 0;
      return {
        ...r,
        ready: { youtube: ytTotal > 0, gemini: aiTotal > 0 },
        note: ytTotal > 0 ? 'Keys loaded and active.' : 'No YouTube API keys loaded.'
      };
    })
  ]
];

// ---------- keys & engines ----------
const enginePool = new Map();
function engineFor(keys) {
  const y = (keys && keys.youtube) || '', g = (keys && keys.gemini) || '';
  const id = crypto.createHash('sha256').update(y + '|' + g).digest('hex');
  let e = enginePool.get(id);
  if (!e) {
    e = createEngine({ youtube: y, gemini: g }, false);
    enginePool.set(id, e);
    if (enginePool.size > 200) enginePool.delete(enginePool.keys().next().value);
  }
  return e;
}
const has = (keys, k) => !!(keys && K.split(keys[k]).length);

// A "seat" is one AI chat connection. It holds that user's keys and its pending key-page code.
const codes = new Map(); // code -> { seat, exp }
function newCode(seat) {
  for (const [c, v] of codes) if (v.exp < Date.now()) codes.delete(c);
  const code = crypto.randomBytes(18).toString('base64url');
  codes.set(code, { seat, exp: Date.now() + 30 * 60e3 });
  seat.code = code;
  return code;
}
const waitFor = (seat, test, ms) => new Promise((res) => {
  const t0 = Date.now();
  const tick = () => (test() ? res(true) : Date.now() - t0 > ms ? res(false) : setTimeout(tick, 1000));
  tick();
});

// Ask for keys: a URL elicitation when the AI app supports it, otherwise a link the AI shows the user.
async function askForKeys(server, seat, need) {
  const url = seat.baseUrl() + '/setup?c=' + newCode(seat);
  const what = need === 'gemini'
    ? 'This AI tool needs a Gemini API key.'
    : 'PranIQ needs your own YouTube API key (Gemini optional) before it can start.';
  const caps = server.server.getClientCapabilities && server.server.getClientCapabilities();
  if (caps && caps.elicitation && caps.elicitation.url) {
    try {
      const r = await server.server.elicitInput({
        mode: 'url',
        elicitationId: seat.code,
        url,
        message: what + ' Open the secure PranIQ page to connect your keys. They are not shared with the AI.'
      });
      if (r && r.action === 'accept') {
        const ok = await waitFor(seat, () => has(seat.keys, need), 50e3); // wait up to 50s for user to submit
        if (ok) return true;
      }
    } catch {}
  }
  seat.lastLink = url;
  return {
    content: [{
      type: 'text',
      text:
`ACTION NEEDED — show this to the user and wait:
${what}
1. Open this secure PranIQ link: ${url}
2. Paste your key(s) there and press "Check & connect". (Keys go straight to PranIQ, not into this chat.)
3. Come back and say "done".
The link works for 30 minutes. Do not ask the user to paste keys in the chat. When they say done, call start_here again, then continue with what they asked.`
    }]
  };
}

function build(seat) {
  const server = new McpServer(
    { name: 'praniq', version: '3.2.0' },
    {
      instructions: 'PranIQ by Pranish Kharal (WhatsApp +977 9700720101): YouTube research (keywords, niches, outliers, channels, videos) and AI tools for creators. At the start of every chat, call start_here before anything else. If it returns a secure PranIQ link, show the link to the user, wait until they say done, call start_here again, then continue. Never ask for API keys in chat. Earnings and growth numbers are estimates.'
    }
  );

  for (const [name, desc, shape, fn] of TOOLS) {
    server.tool(name, desc, shape, async (a) => {
      try {
        if (name === 'start_here') {
          if (!has(seat.keys, 'youtube')) {
            const r = await askForKeys(server, seat, 'youtube');
            if (r !== true) return r;
          }
          const ny = K.split(seat.keys.youtube).length, ng = K.split(seat.keys.gemini).length;
          return out(`Ready. PranIQ is connected with the user's own keys (YouTube: ${ny}, Gemini: ${ng}${ng ? '' : ' — AI tools will ask for a Gemini key when needed'}). Continue with what the user asked.`);
        }
        if (name !== 'bulk_keywords' && !has(seat.keys, 'youtube')) {
          const r = await askForKeys(server, seat, 'youtube');
          if (r !== true) return r;
        }
        try {
          return out(await fn(a || {}, engineFor(seat.keys).call));
        } catch (e) {
          if (e.message === 'NEEDS_GEMINI_KEY' || e.message === 'NEEDS_YOUTUBE_KEY') {
            const need = e.message === 'NEEDS_GEMINI_KEY' ? 'gemini' : 'youtube';
            const r = await askForKeys(server, seat, need);
            if (r !== true) return r;
            return out(await fn(a || {}, engineFor(seat.keys).call));
          }
          throw e;
        }
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: errText(e) }] };
      }
    });
  }
  return server;
}

// ---------- key page (shared by both modes) ----------
function mountSetup(app, { local }) {
  const express = require('express');
  app.get('/setup', (req, res) => {
    const c = String(req.query.c || '');
    res.set('Cache-Control', 'no-store');
    res.send(codes.has(c) && codes.get(c).exp > Date.now() ? page.form(c) : page.expired());
  });

 
app.post('/setup', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');

  // Safely handle missing or invalid request bodies
  const body = req.body && typeof req.body === 'object'
    ? req.body
    : {};

  const c = String(body.c || '');
  const entry = codes.get(c);

  if (!c || !entry || entry.exp < Date.now()) {
    return res.status(400).send(page.expired());
  }

  const v = await K.verify({
    youtube: body.youtube,
    gemini: body.gemini
  });

  if (!v.youtube.length) {
    return res.send(page.form(
      c,
      `<div class="bad">No working YouTube key. ${v.problems.map(page.esc).join('<br>')}</div>`
    ));
  }

  const seat = entry.seat;

  const keys = {
    youtube: v.youtube.join(','),
    gemini: v.gemini.join(',') || (seat.keys && seat.keys.gemini) || ''
  };

  seat.keys = keys;
  codes.delete(c);

  if (local) K.saveLocal(keys);
  if (seat.notify) seat.notify().catch(() => {});

  const personal = local ? '' : seat.baseUrl() + '/mcp?u=' + K.seal(keys);

  res.send(page.done({
    yt: v.youtube.length,
    gm: K.split(keys.gemini).length,
    personal,
    problems: v.problems,
    local
  }));
});


module.exports = { build, TOOLS, mountSetup, engineFor, codes };

if (require.main === module) {
  const express = require('express');
  if (process.argv.includes('--http')) {
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
    const app = express();
    app.set('trust proxy', true);
    const token = PUBLIC ? '' : process.env.PRANIQ_TOKEN;
    const base = (req) => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const sessions = new Map();

    app.get('/', (_, res) => res.send('PranIQ MCP server 3.2.0 is running. Endpoint: /mcp · Made by Pranish Kharal · WhatsApp +977 9700720101'));
    mountSetup(app, { local: false });

    const keysFrom = (req) => {
      const u = req.query.u && K.open(req.query.u);
      if (u) return u;
      const y = req.headers['x-youtube-key'] || req.headers['x-youtube-keys'] || req.query.yt || req.query.youtube || '';
      const g = req.headers['x-gemini-key'] || req.headers['x-gemini-keys'] || req.query.gemini || '';
      if (y || g) return { youtube: String(y), gemini: String(g) };
      return PUBLIC ? { youtube: '', gemini: '' } : { ...envKeys };
    };

    app.all('/mcp', express.json({ limit: '2mb' }), async (req, res) => {
      if (token && req.headers.authorization !== 'Bearer ' + token && req.query.token !== token) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      const sid = req.headers['mcp-session-id'];
      let s = sid && sessions.get(sid);
      if (!s) {
        if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
          return res.status(sid ? 404 : 400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: sid ? 'Session expired, reconnect' : 'Start with an initialize request' },
            id: null
          });
        }
        const b = base(req);
        const seat = { keys: keysFrom(req), baseUrl: () => b };
        const server = build(seat);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => sessions.set(id, s = { transport, server, seat, t: Date.now() })
        });
        seat.notify = async () => {
          if (seat.code) {
            try { await server.server.createElicitationCompletionNotifier(seat.code)(); } catch {}
          }
        };
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        s = { transport, server, seat };
      }
      s.t = Date.now();
      await s.transport.handleRequest(req, res, req.body);
    });

    setInterval(() => {
      for (const [id, s] of sessions) {
        if (Date.now() - s.t > 6 * 3600e3) {
          s.transport.close();
          sessions.delete(id);
        }
      }
    }, 600e3).unref();

    const port = process.env.PORT || 3333;
    app.listen(port, () => console.error(`PranIQ MCP on port ${port} (/mcp)${PUBLIC ? ' · public mode: users connect their own keys' : ''}`));
  } else {
    const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
    const saved = K.loadLocal();
    const seat = { keys: envKeys.youtube ? { ...envKeys } : saved };
    const sport = +(process.env.PRANIQ_SETUP_PORT || 3335);
    seat.baseUrl = () => `http://127.0.0.1:${sport}`;

    // Local key page, only reachable from this computer.
    const app = express();
    mountSetup(app, { local: true });
    app.listen(sport, '127.0.0.1').on('error', () => console.error('PranIQ: key page port ' + sport + ' busy; set PRANIQ_SETUP_PORT'));

    const server = build(seat);
    seat.notify = async () => {
      if (seat.code) {
        try { await server.server.createElicitationCompletionNotifier(seat.code)(); } catch {}
      }
    };
    if (!has(seat.keys, 'youtube')) {
      console.error('PranIQ: no keys yet. The AI will show the user a key page link on first use.');
    }
    server.connect(new StdioServerTransport());
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('close', () => process.exit(0));
  }
}
