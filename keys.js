// PranIQ key helpers: personal links (keys encrypted inside the link), key checks, local key file.
const crypto = require('crypto'), fs = require('fs'), path = require('path'), os = require('os');
const DIR = process.env.PRANIQ_HOME || path.join(os.homedir(), '.praniq');
const ensureDir = () => { try { fs.mkdirSync(DIR, { recursive: true }); } catch {} };

let SECRET = process.env.PRANIQ_SECRET;
if (!SECRET) {
  const f = path.join(DIR, 'secret');
  try { SECRET = fs.readFileSync(f, 'utf8').trim(); } catch {}
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); ensureDir(); try { fs.writeFileSync(f, SECRET, { mode: 0o600 }); } catch {} }
}
const K = crypto.createHash('sha256').update(String(SECRET)).digest();
const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function seal(keys) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', K, iv);
  const enc = Buffer.concat([c.update(JSON.stringify({ y: keys.youtube || '', g: keys.gemini || '' }), 'utf8'), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), enc]));
}
function open(token) {
  try {
    const b = unb64u(token), d = crypto.createDecipheriv('aes-256-gcm', K, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const j = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
    return { youtube: j.y || '', gemini: j.g || '' };
  } catch { return null; }
}

const split = (v) => [...new Set(String(v || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
async function checkYouTube(key) {
  try {
    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=' + encodeURIComponent(key));
    const d = await r.json();
    if (!d.error) return { ok: true };
    const reason = d.error.errors && d.error.errors[0] && d.error.errors[0].reason;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return { ok: true, note: 'valid, but today\'s quota is used up' };
    return { ok: false, why: d.error.message || 'rejected' };
  } catch (e) { return { ok: false, why: 'could not reach Google: ' + e.message }; }
}
async function checkGemini(key) {
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=' + encodeURIComponent(key));
    const d = await r.json();
    return d.error ? { ok: false, why: d.error.message || 'rejected' } : { ok: true };
  } catch (e) { return { ok: false, why: 'could not reach Google: ' + e.message }; }
}
const mask = (k) => (k.length > 10 ? k.slice(0, 4) + '…' + k.slice(-4) : '••••');

// Check every key the user typed; keep only the good ones.
async function verify({ youtube, gemini }) {
  const res = { youtube: [], gemini: [], problems: [] };
  for (const k of split(youtube)) { const r = await checkYouTube(k); r.ok ? res.youtube.push(k) : res.problems.push(`YouTube key ${mask(k)}: ${r.why}`); }
  for (const k of split(gemini)) { const r = await checkGemini(k); r.ok ? res.gemini.push(k) : res.problems.push(`Gemini key ${mask(k)}: ${r.why}`); }
  return res;
}

// Local (stdio) mode: keys typed on the setup page are saved on this computer only.
const LOCAL = path.join(DIR, 'keys.json');
function loadLocal() { try { const j = JSON.parse(fs.readFileSync(LOCAL, 'utf8')); return { youtube: j.youtube || '', gemini: j.gemini || '' }; } catch { return { youtube: '', gemini: '' }; } }
function saveLocal(keys) { ensureDir(); fs.writeFileSync(LOCAL, JSON.stringify(keys), { mode: 0o600 }); }

module.exports = { seal, open, verify, split, mask, loadLocal, saveLocal, LOCAL };
