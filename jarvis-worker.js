// Jarvis backend — a small, stateless Cloudflare Worker.
//
// What it does: holds your API keys server-side so they never sit in the
// browser, and relays Jarvis's AI requests to Anthropic (Claude) and MindsHub (Jev).
// What it does NOT do: store anything. There is no database; all of Jarvis's
// data still lives in your own Google Drive.
//
// Required settings (Worker → Settings → Variables and Secrets):
//   APP_TOKEN          (secret)  a long random string; Jarvis sends it with every request
//   ANTHROPIC_API_KEY  (secret)  your Anthropic key        — needed for /claude
//   MINDSHUB_API_KEY   (secret)  your MindsHub key         — needed for /jev (optional)
//   ALLOWED_ORIGIN     (text)    https://mogalemahlaba-bot.github.io   (no trailing slash, no path)

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MINDSHUB_URL = 'https://api.mindshub.ai/v1/decisions';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'; // forced, so a leaked token can't run pricier models
const MAX_BODY_CHARS = 100000;
const MAX_TOKENS_CAP = 1000;

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGIN || '').trim();
  const h = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (allowed && origin === allowed) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // Unauthenticated, so you can confirm the Worker is deployed by opening /health in a browser.
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true }, 200, cors);

    // Browsers from any other website are refused outright.
    if (origin && origin !== (env.ALLOWED_ORIGIN || '').trim()) {
      return json({ error: 'Origin not allowed' }, 403, cors);
    }

    if (!env.APP_TOKEN) return json({ error: 'APP_TOKEN is not set on the backend' }, 500, cors);
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!safeEqual(token, env.APP_TOKEN)) return json({ error: 'Unauthorized' }, 401, cors);

    if (url.pathname === '/status' && request.method === 'GET') {
      return json({ ok: true, claude: !!env.ANTHROPIC_API_KEY, jev: !!env.MINDSHUB_API_KEY }, 200, cors);
    }

    if (url.pathname !== '/claude' && url.pathname !== '/jev') return json({ error: 'Not found' }, 404, cors);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return json({ error: 'Request too large' }, 413, cors);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }

    try {
      let upstream;
      if (url.pathname === '/claude') {
        if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set on the backend' }, 500, cors);
        body.model = CLAUDE_MODEL;
        body.max_tokens = Math.min(Number(body.max_tokens) || 400, MAX_TOKENS_CAP);
        delete body.stream;
        upstream = await fetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });
      } else {
        if (!env.MINDSHUB_API_KEY) return json({ error: 'MINDSHUB_API_KEY is not set on the backend' }, 500, cors);
        body.model = 'jev';
        upstream = await fetch(MINDSHUB_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.MINDSHUB_API_KEY },
          body: JSON.stringify(body),
        });
      }
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', ...cors },
      });
    } catch (e) {
      return json({ error: 'Upstream request failed' }, 502, cors);
    }
  },
};
