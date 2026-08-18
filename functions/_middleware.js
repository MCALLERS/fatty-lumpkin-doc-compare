/**
 * Cloudflare Pages password gate (HTTP Basic Auth).
 *
 * Set FATTY_USER and FATTY_PASSWORD under Settings → Environment variables for
 * BOTH Production and Preview, then redeploy — environment variables only take
 * effect on a new deployment.
 *
 * If the variables are missing the site fails CLOSED with a 503. That is
 * deliberate: an unconfigured gate must never serve the site unprotected.
 */

const REALM = 'Fatty Lumpkin Doc Compare';

/**
 * The browser's own credential prompt is unavoidable with Basic Auth, but the
 * page behind it is the first thing a colleague sees if they cancel or get it
 * wrong -- so it is written and styled rather than left as a bare string.
 */
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Fatty Lumpkin Doc Compare</title>
<style>
  :root{ color-scheme:light dark; --paper:#FBF7EE; --ink:#1C1A15; --ink-2:#57503F; --surface:#fff; --line:#8E8270; }
  @media (prefers-color-scheme:dark){ :root{ --paper:#15141A; --ink:#F1ECE2; --ink-2:#B5AE9F; --surface:#22212A; --line:#767286; } }
  body{ margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
    background:var(--paper); color:var(--ink);
    font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .card{ max-width:30rem; background:var(--surface); border:1px solid var(--line);
    border-radius:20px; padding:32px; text-align:center; }
  img{ width:96px; height:96px; margin:0 auto 16px; display:block; border-radius:24px; }
  h1{ margin:0 0 8px; font-size:21px; letter-spacing:-.01em; }
  p{ margin:0; color:var(--ink-2); font-size:15px; }
  p + p{ margin-top:12px; }
</style></head><body><div class="card">
<img src="/assets/pony-mark.webp" alt="">
<h1>${title}</h1>
${body}
</div></body></html>`;
}

function unauthorized() {
  return new Response(page(
    'This page needs a password',
    '<p>Fatty Lumpkin Doc Compare is shared internally. Reload the page and enter the username and password you were sent.</p>'
    + '<p>Don’t have them? Ask Michael — <a href="mailto:mcallers@gmail.com">mcallers@gmail.com</a>.</p>',
  ), {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function notConfigured() {
  return new Response(page(
    'Not quite ready',
    '<p>The access password for this site hasn’t been set up yet, so it is deliberately serving nothing at all rather than serving itself unprotected.</p>'
    + '<p>If this is your site: set <code>FATTY_USER</code> and <code>FATTY_PASSWORD</code> in the Cloudflare Pages environment variables, then redeploy.</p>',
  ), {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Length-independent comparison, so timing never leaks the password. */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a || '');
  const y = enc.encode(b || '');
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export async function onRequest(context) {
  const { request, env, next } = context;

  const user = env.FATTY_USER;
  const password = env.FATTY_PASSWORD;
  if (!user || !password) return notConfigured();

  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return unauthorized();

  let decoded = '';
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return unauthorized();
  }

  const split = decoded.indexOf(':');
  if (split < 0) return unauthorized();

  const okUser = safeEqual(decoded.slice(0, split), user);
  const okPass = safeEqual(decoded.slice(split + 1), password);
  if (!(okUser && okPass)) return unauthorized();

  const response = await next();
  const out = new Response(response.body, response);
  out.headers.set('Cache-Control', 'private, no-cache');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return out;
}
