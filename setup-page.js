// The secure PranIQ key page. Keys are typed here, never in the AI chat.
const WA = 'https://wa.me/9779700720101?text=' + encodeURIComponent('Hi Pranish! I am using PranIQ MCP. I want more tools and info.');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shell = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>PranIQ · Connect your keys</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0f17;color:#ececf4;display:grid;place-items:center;min-height:100vh;padding:20px}
.card{width:100%;max-width:520px;background:#181824;border:1px solid #2a2a3a;border-radius:16px;padding:28px}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px}.logo i{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#6d28d9,#db2777);display:grid;place-items:center;font-style:normal}
h1{font-size:18px;margin:18px 0 4px}p{color:#a8a8bc;margin:6px 0}label{display:block;font-weight:700;margin:18px 0 6px}
textarea{width:100%;min-height:62px;background:#0f0f17;color:#fff;border:1px solid #33334a;border-radius:10px;padding:10px;font:13px ui-monospace,monospace;resize:vertical}
small{color:#8a8aa0}button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:10px;background:linear-gradient(135deg,#6d28d9,#db2777);color:#fff;font-weight:800;font-size:15px;cursor:pointer}
.ok{background:#11301f;border:1px solid #1f6b3e;color:#b5f5cf;padding:12px;border-radius:10px;margin-top:14px}.bad{background:#341319;border:1px solid #7a2632;color:#ffc2cc;padding:12px;border-radius:10px;margin-top:14px}
.link{word-break:break-all;background:#0f0f17;border:1px solid #33334a;border-radius:10px;padding:10px;font:12px ui-monospace,monospace;margin-top:8px}
a{color:#c4a5ff}.foot{display:flex;justify-content:space-between;align-items:center;margin-top:22px;padding-top:14px;border-top:1px solid #2a2a3a;font-size:13px;color:#8a8aa0}
.wa{background:#25d366;color:#fff;text-decoration:none;border-radius:16px;padding:6px 12px;font-weight:700}</style></head><body><div class="card">
<div class="logo"><i>P</i>PranIQ</div>${body}
<div class="foot"><span>Made by <b>Pranish Kharal</b></span><a class="wa" href="${WA}" target="_blank" rel="noopener">WhatsApp</a></div></div></body></html>`;

function form(code, msg = '') {
  return shell(`<h1>Connect your API keys</h1>
<p>PranIQ runs on <b>your own</b> keys. They go straight to PranIQ, not into the AI chat.</p>${msg}
<form method="post" action="setup" autocomplete="off">
<input type="hidden" name="c" value="${esc(code)}">
<label>YouTube Data API v3 key <span style="color:#f472b6">*</span></label>
<textarea name="youtube" required placeholder="AIza…  (several keys? one per line)"></textarea>
<small>Google Cloud Console → APIs &amp; Services → Credentials → Create API key (enable “YouTube Data API v3”).</small>
<label>Gemini API key <span style="color:#8a8aa0;font-weight:400">(optional, for AI tools)</span></label>
<textarea name="gemini" placeholder="AIza…"></textarea>
<small>Google AI Studio → Get API key.</small>
<button type="submit">Check &amp; connect</button></form>`);
}
function done({ yt, gm, personal, problems, local }) {
  const warn = problems.length ? `<div class="bad">Skipped: ${problems.map(esc).join('<br>')}</div>` : '';
  const keep = local
    ? '<p>Saved on this computer. PranIQ will remember them next time.</p>'
    : `<p style="margin-top:16px"><b>Never type keys again:</b> save this personal PranIQ link and use it as your connector URL instead of the normal one. Keep it private: it carries your keys (encrypted).</p><div class="link">${esc(personal)}</div>`;
  return shell(`<div class="ok">✅ Connected: ${yt} YouTube key${yt === 1 ? '' : 's'}, ${gm} Gemini key${gm === 1 ? '' : 's'}.</div>${warn}
<h1>You're all set</h1><p>Go back to your AI chat and say <b>“done”</b>. It will continue.</p>${keep}`);
}
const expired = () => shell('<h1>This link has expired</h1><p>Go back to your AI chat and ask it to use PranIQ again. It will give you a fresh link.</p>');
module.exports = { form, done, expired, esc };
