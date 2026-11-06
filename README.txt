================================================================================
PranIQ MCP Server 3.2
Made by Pranish Kharal · WhatsApp +977 9700720101
================================================================================

PranIQ is a high-performance YouTube research and AI automation toolkit designed
specifically for faceless and automation creators (similar to vidIQ and NexLev).

It runs the exact same proven engine as the PranIQ Chrome extension, now packaged
as a standard Model Context Protocol (MCP) server so any AI agent or desktop app
(Antigravity, Claude Desktop, Cursor, ChatGPT, Hark) can execute YouTube research
and generate full production scripts autonomously.

--------------------------------------------------------------------------------
QUICK START — NO KEYS IN CONFIG NEEDED
--------------------------------------------------------------------------------
1. Add PranIQ to your MCP config with ONLY command and args (no env block needed):

   {
     "mcpServers": {
       "praniq": {
         "command": "node",
         "args": ["/full/path/to/praniq-mcp/server.js"]
       }
     }
   }

2. Restart your AI app and start a new chat.
3. The AI will call start_here automatically. If you have no keys yet, PranIQ
   gives you a secure link: http://127.0.0.1:3335/setup?c=...
4. Open that link in your browser, paste your YouTube API key (Gemini optional),
   click "Check & connect", then say "done" in chat.
5. Done! Your keys are saved on your computer. You will never be asked again.

   Where to get keys (free):
   • YouTube Data API v3 key → Google Cloud Console → APIs & Services → Credentials
   • Gemini API key          → Google AI Studio (aistudio.google.com)

   NEVER paste your keys into the chat. The setup link keeps them private.

--------------------------------------------------------------------------------
SECURE KEY PAGE (v3.2)
--------------------------------------------------------------------------------
When someone starts a chat, the AI calls start_here first. If PranIQ has no keys
for them, it returns a secure PranIQ link. The user opens the link, pastes their
YouTube key (Gemini optional), clicks "Check & connect", and says "done" in chat.
Keys are checked with Google (1 unit) and never pass through the AI chat.
Apps that support MCP "URL elicitation" can open the page for them automatically!

• On a computer (stdio):
  The key page opens at http://127.0.0.1:3335 (reachable only from that computer)
  and good keys are saved in ~/.praniq/keys.json. Once set, you're never asked again.
• Online (Render / Railway / VPS):
  After connecting keys on /setup, the page generates a PERSONAL PranIQ link:
  https://YOUR-APP-URL/mcp?u=<encrypted-keys>
  Keys are encrypted using AES-256-GCM with PRANIQ_SECRET. Using this personal link
  in your AI connector means you are never asked again across restarts or sessions!

ADVANCED: Keys in MCP config env, headers (X-YouTube-Key, X-Gemini-Key), or
query parameters (?yt=KEY&gemini=KEY) also work if you prefer that method.

PUBLIC SERVER MODE (Render, Railway, Fly.io):
• PRANIQ_USER_KEYS_ONLY=1   Everyone uses their own keys; server keys are disabled.
• PRANIQ_SECRET=<secret>    REQUIRED so personal encrypted links survive restarts.
• PUBLIC_URL=https://app    Your public HTTPS URL (auto-detected on Render).
• No PRANIQ_TOKEN needed in public mode.

Antigravity Remote Connector Example:
{
  "mcpServers": {
    "praniq": {
      "serverUrl": "https://YOUR-APP/mcp",
      "headers": {
        "X-YouTube-Key": "your-youtube-key",
        "X-Gemini-Key": "your-gemini-key"
      }
    }
  }
}

--------------------------------------------------------------------------------
18 BUILT-IN TOOLS
--------------------------------------------------------------------------------
1.  start_here             CALL THIS FIRST. Verifies user has connected keys or
                           provides a secure setup link. Never asks for keys in chat.
2.  keyword_score          Score a YouTube keyword (0-100 score, search demand,
                           competition level, top 20 videos). 24h disk cached.
3.  bulk_keywords          Expand seed into dozens of autocomplete searches ranked
                           by popularity proxy. 100% free, 0 API units used.
4.  niche_finder           Discover & validate small/new channels getting massive
                           views with go/no-go scores and monthly earnings estimates.
5.  outlier_videos         Find viral breakout videos with 2x-10x+ higher views
                           than the channel's baseline. 24h disk cached.
6.  channel_analysis       Full channel stats, upload pace, estimated earnings,
                           and recent video outlier performance. 6h disk cached.
7.  channel_growth         Estimated daily/weekly/monthly views gained and top videos.
8.  compare_channels       Side-by-side performance comparison for 2-3 channels.
9.  similar_channels       Discover competitor channels in the same niche.
10. video_analysis         Video deep-dive: views, VPH, engagement rate, outlier score,
                           SEO tags, description analysis, and channel stats.
11. video_transcript       Extract complete captions & timestamps. Free (0 API units).
12. video_pack             AI Production Pack: generates 5 high-CTR titles, hook,
                           word-by-word script, scene breakdown with image prompts,
                           SEO description, tags, pinned comment & Shorts ideas.
13. rewrite_script         AI Script Rewriter: rewrites an existing video transcript
                           into an original script with a fresh angle.
14. shorts_clips           AI Clip Finder: scans transcript for best 20-58s viral clips.
15. thumbnail_review       AI Vision: analyzes thumbnail image for contrast, mobile
                           readability, clutter, focal point, and emotional draw.
16. title_ideas_for_video  AI Title Optimizer: remixes 10 high-CTR curiosity titles.
17. ai_writer              AI Studio for YouTube: ideas, titles, hooks, descriptions,
                           tags, scripts, shorts, channel plans, 30-day calendars.
18. api_key_status         Live quota dashboard: shows active/resting keys, daily
                           searches & units used per key (resets midnight PT),
                           and disk cache statistics.

--------------------------------------------------------------------------------
QUOTA SAVING & DISK CACHE (BUILT-IN)
--------------------------------------------------------------------------------
• 24-Hour Disk Cache: YouTube search results are cached to praniq-cache.json for
  24 hours. Repeating queries uses 0 API units across all users.
• 6-Hour Disk Cache: Video, channel, and playlist stats are cached for 6 hours.
• Multi-Key Rotation: Supports comma-separated keys. If a key hits its daily limit,
  PranIQ automatically rests that key until midnight Pacific Time and switches to
  the next available key without interruption.
• Quota Tracking: Tracks daily search calls and total units used per key (hashed).
  Resets cleanly at midnight Pacific Time (PT).
• Proactive Warnings: When searches are nearly exhausted (<15 left), tools
  automatically append a friendly quota warning to their output.

--------------------------------------------------------------------------------
HOW TO USE (EXAMPLE PROMPTS FOR AI APPS)
--------------------------------------------------------------------------------
Once connected to your AI assistant, simply ask naturally:

• First Step:
  "Call start_here to make sure my YouTube and Gemini API keys are ready."

• Niche Discovery:
  "Use PranIQ to check the niche 'stick man history'. Find small channels getting
   high views and tell me if it's worth starting a channel in this niche."

• Keyword Research:
  "Find 30 long-tail keywords for 'ai history' using PranIQ bulk_keywords, then
   score the top 3 with keyword_score."

• Viral Outlier Finder:
  "Find outlier videos in the 'stoicism' niche from the last 30 days that have
   at least 3x more views than the channel normally gets."

• Competitor Analysis:
  "Analyze channel @MagnatesMedia and give me their upload pace, best performing
   videos, and estimated monthly earnings."

• Complete Video Production:
  "Generate a full 8-minute video pack for 'ancient Egypt mysteries' with titles,
   a hypnotic hook, full script, scene-by-scene image prompts, and SEO tags."

• Script Rewriting:
  "Extract the transcript from https://www.youtube.com/watch?v=VIDEO_ID and
   rewrite it into an original script with an investigative journalism angle."

• Quota Check:
  "Check PranIQ api_key_status to see how many searches and units I've used today."

================================================================================
Made by Pranish Kharal · WhatsApp +977 9700720101
================================================================================
