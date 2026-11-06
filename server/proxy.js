/**
 * The local server.
 *
 * Serves the app and forwards /api/* to eodhd.com, adding the API key here
 * rather than in the browser. Two reasons, in order of importance:
 *
 *   1. The key stays on the developer's machine. It is in .env, it is read by
 *      this process, and it is never sent to the page. That is the pattern a
 *      real application would use, and a sample that taught the opposite would
 *      be worse than no sample.
 *   2. eodhd.com does not send Access-Control-Allow-Origin, so a page cannot
 *      call it directly at all. Measured 2026-08-19; every competitor does
 *      send it, and we are the exception.
 *
 * No dependencies, on purpose. Installing a sample app should not pull
 * down a tree of packages a stranger has to audit before running it.
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const UPSTREAM = 'https://eodhd.com';
const PLACEHOLDERS = ['your_api_key_here', 'your-api-key-here', 'demo', ''];

// The first path segment of every endpoint the seven apps reach for. Anything
// else is refused here rather than signed with the key and sent on.
const UPSTREAM_ALLOWED = [
  'calendar', 'div', 'economic-events', 'eod', 'exchange-details', 'exchange-symbol-list',
  'fundamentals', 'macro-indicator', 'mp', 'news', 'real-time', 'screener',
  'search', 'sec-filings', 'sentiments', 'technical', 'us-quote-delayed', 'v1.1',
];

// Encoded separators, dots, query and fragment marks, percent itself and
// control characters. None of these apps ever needs one in a path -- a symbol
// is letters, digits, dots and dashes, and a search term with a space arrives
// as %20, which is fine -- and each is a way to make eodhd.com's router see a
// different path from the one checked here. `/api/eod/..%2Fuser` went upstream
// as written; eodhd.com does not decode it today, and the check should not
// rest on that. The terminal refuses the same class in its own proxy.
const ENCODED_HAZARD = /%(2f|5c|2e|3f|23|25|[01][0-9a-f]|7f)/i;

// The AI route reads a body, and the body goes to a provider on the
// developer's bill. There was no limit: a 20 MB prompt was read whole and
// forwarded.
const AI_BODY_LIMIT = 256 * 1024;
// A model can take a while -- a local Ollama loading one takes most of a
// minute -- but not for ever. There was no deadline at all, and a stalled
// provider left the page on "Analysing..." indefinitely.
const AI_TIMEOUT_MS = 90000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Shorter than this is not an EODHD key -- theirs are twenty-odd characters --
// and a five-character "key" did two bad things at once: it went upstream to a
// puzzling 401, and scrub() then blanked every occurrence of those five letters
// out of the market data on its way back ("Ni[redacted]ei 225").
const MIN_KEY_LENGTH = 12;

/**
 * Parse a .env file. Deliberately small: KEY=value, quotes and comments.
 *
 * `export KEY=value` is accepted, because people paste from their shell
 * profile. An unquoted value stops at ` #`, because `KEY=abc # my test key`
 * used to send "abc # my test key" upstream and answer with a 401 instead of
 * the setup screen.
 */
function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    const quoted = value.match(/^(['"])(.*)\1(\s*#.*)?$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    // .env.example ships a placeholder. Passing it upstream would give the
    // developer a puzzling 401 instead of the setup screen that tells them
    // exactly what to do.
    //
    // The original is kept alongside so the startup message can name the value
    // it ignored. "No key set" is a confusing thing to read when you have just
    // typed one in.
    // Compared lower-case: eodhd.com accepts demo, DEMO and Demo alike, and
    // this list only held the lower one -- so EODHD_API_KEY=DEMO sailed past
    // the check written to stop exactly that and ran on the shared public
    // token.
    if (PLACEHOLDERS.includes(String(value).toLowerCase())) {
      out[m[1] + '_RAW'] = value;
      value = '';
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Turn an incoming /api/... request into the upstream URL.
 *
 * Built against a fixed origin rather than by string concatenation, so no
 * amount of ../ or //evil.com in the path can send the key somewhere else.
 */
function buildUpstreamUrl(reqUrl, key) {
  const rawPath = String(reqUrl).split(/[?#]/)[0];
  if (ENCODED_HAZARD.test(rawPath) || rawPath.indexOf('\\') !== -1) return null;
  const incoming = new URL(reqUrl, 'http://localhost');
  const upstreamPath = path.posix.normalize(incoming.pathname).replace(/^(\.\.[/])+/, '');
  // Under /api/ or nowhere. The origin could never be changed, but
  // `/api/../../evil` normalised to `/evil` and went upstream as
  // https://eodhd.com/evil?api_token=... -- a request this server has no
  // business making on anybody's behalf. Null here is a 404.
  if (upstreamPath.indexOf('/api/') !== 0) return null;
  // Only the feeds these apps use. The path was forwarded verbatim, so
  // `GET /api/user` -- which no app here calls -- answered with the key
  // owner's e-mail address, plan and remaining quota to anything that could
  // reach this server. A proxy that carries a key should carry it to a known
  // list of destinations.
  const first = upstreamPath.slice('/api/'.length).split('/')[0];
  if (!UPSTREAM_ALLOWED.includes(first)) return null;
  const url = new URL(upstreamPath, UPSTREAM);
  // Checked again on the parsed URL: the parser decodes %2e%2e to .. and
  // resolves it, so `/api/%2e%2e/evil` passes the text check above and still
  // comes out as /evil.
  if (url.pathname.indexOf('/api/') !== 0) return null;
  for (const [k, v] of incoming.searchParams) {
    // Whatever the page sent, our key is the one that gets used. A page has no
    // business supplying one, and if it does it is either a mistake or an
    // attempt to spend somebody else's quota through us.
    if (k === 'api_token') continue;
    url.searchParams.append(k, v);
  }
  url.searchParams.set('api_token', key);
  return url;
}

/**
 * Fundamentals without Morningstar's data. EODHD's ETF and fund payloads carry
 * it as ETF_Data.MorningStar, MutualFund_Data.Morning_Star_* and the
 * Morningstar category name (Category / Fund_Category / Fund_Style) on ETFs
 * and funds; none of the apps uses it, so it does not leave this server. Same
 * rule as shell/api.js and the terminal's backend.
 */
// Relative_to_Category and ETF_Data.Valuations_Growth's *_Rates_To_Category
// are comparisons with Morningstar's category; the fund's own figures beside
// them (Valuations_Rates_Portfolio, Growth_Rates_Portfolio) stay.
const MORNINGSTAR_KEY = /morning_?star|(?:relative|rates)_to_category/i;
const FUND_CLASSIFICATION = ['Category', 'Fund_Category', 'Fund_Style'];

function stripMorningstar(data) {
  if (Array.isArray(data)) return data.map(stripMorningstar);
  if (!data || typeof data !== 'object') return data;
  const fundLike = /^(ETF|FUND)$/i.test(String(data.Type || '')) || 'Fund_Category' in data || 'Nav' in data;
  const out = {};
  Object.keys(data).forEach(function (k) {
    if (MORNINGSTAR_KEY.test(k)) return;
    if (fundLike && FUND_CLASSIFICATION.indexOf(k) !== -1) return;
    out[k] = stripMorningstar(data[k]);
  });
  return out;
}

/** A fundamentals `filter` that names one of those fields directly. */
function asksForMorningstar(filter) {
  return String(filter || '').split(',').map(function (p) { return p.trim(); }).filter(Boolean)
    .some(function (p) { return MORNINGSTAR_KEY.test(p) || FUND_CLASSIFICATION.indexOf(p.split('::').pop()) !== -1; });
}

/** /api/fundamentals/..., /api/v1.1/fundamentals/..., /api/bulk-fundamentals/... */
function isFundamentalsPath(pathname) {
  const segs = String(pathname || '').split('/').filter(Boolean);
  if (segs[0] !== 'api') return false;
  const family = /^v\d/.test(segs[1] || '') ? segs[2] : segs[1];
  return family === 'fundamentals' || family === 'bulk-fundamentals';
}

/** Fetch upstream over https, returning status, headers and body as text. */
// Long enough for a slow marketplace page, short enough that a socket which
// was accepted and then went quiet does not leave the page on "Loading…" for
// ever. There was no timeout at all: a stalled upstream hung the app.
const UPSTREAM_TIMEOUT_MS = 20000;
// The news feed is the slow one: /api/news?s=AAPL.US answered in 14 to 22
// seconds (measured 12 Oct 2026), so the 20 above cut it off and the page got
// a 502 for news that was on its way. Only this feed gets longer; shell/api.js
// waits five seconds past it, as it does for the rest (20 / 25).
const SLOW_UPSTREAM_TIMEOUT_MS = { news: 45000 };

/** How long an upstream path may take: by its first segment after /api/. */
function upstreamTimeoutMs(pathname) {
  const first = String(pathname || '').split('/').filter(Boolean)[1] || '';
  return Object.prototype.hasOwnProperty.call(SLOW_UPSTREAM_TIMEOUT_MS, first)
    ? SLOW_UPSTREAM_TIMEOUT_MS[first] : UPSTREAM_TIMEOUT_MS;
}

// `opts.timeoutMs` and an http: URL are for the tests, which stand a slow
// server up on localhost; the handler passes neither, and buildUpstreamUrl
// only ever builds https://eodhd.com.
function fetchUpstream(url, _req, opts) {
  const deadline = (opts && opts.timeoutMs) || upstreamTimeoutMs(url.pathname);
  const lib = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.get(url.toString(), (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(deadline, () => {
      req.destroy(new Error('eodhd.com did not answer within ' + (deadline / 1000) + ' seconds'));
    });
  });
}

/**
 * 'free', 'paid', or null when it could not be told. Read from EODHD's
 * /api/user once per key and process; an unanswered question is asked again
 * next time rather than remembered.
 */
const PLAN_TIMEOUT_MS = 5000;
const planCache = new Map();
async function planOf(key, upstream) {
  if (planCache.has(key)) return planCache.get(key);
  let plan = null;
  try {
    const url = new URL('/api/user', UPSTREAM);
    url.searchParams.set('api_token', key);
    url.searchParams.set('fmt', 'json');
    const answer = await upstream(url, null, { timeoutMs: PLAN_TIMEOUT_MS });
    if (answer && answer.status === 200) plan = planFromUser(JSON.parse(answer.body));
  } catch (_) { plan = null; }
  if (plan) planCache.set(key, plan);
  return plan;
}
/** The free tier is twenty requests a day; anything above it is a paid plan. */
function planFromUser(user) {
  if (!user || typeof user !== 'object') return null;
  const limit = Number(user.dailyRateLimit);
  if (/free/i.test(String(user.subscriptionType || ''))) return 'free';
  if (Number.isFinite(limit) && limit > 0) return limit <= 20 ? 'free' : 'paid';
  return user.subscriptionType ? 'paid' : null;
}

/** Remove every configured secret from anything on its way back to the browser. */
function scrub(text, keys) {
  if (!text) return text;
  let out = String(text);
  for (const k of [].concat(keys)) {
    // A string too short to be a key is not scrubbed: it would be found
    // inside ordinary words and blank real values out of market data.
    if (k && k.length >= MIN_KEY_LENGTH) out = out.split(k).join('[redacted]');
  }
  return out;
}

/**
 * Additionally strip anything key-shaped, for text a provider wrote.
 *
 * scrub() removes the exact strings we hold, which is the right guarantee and
 * not enough here. Asked to analyse anything with a stale key, OpenAI replies
 * "Incorrect API key provided: sk-proj-****...abcd" -- their own masking, so
 * not a leak, but a hundred and sixty characters of asterisks in the middle of
 * a sentence, and the first thing a developer does with an error like that is
 * paste the page into an issue.
 *
 * The actionable half of the sentence is kept. Only the token goes.
 *
 * Applied to what the provider wrote -- its error text and its answer -- and
 * never to EODHD's responses: an EODHD key is dot-separated hex and a rule
 * wide enough to catch one would eat real values out of market data.
 *
 * The tail has to be sixteen characters or more. At eight, "api-documentation"
 * was a key; no provider key is shorter than sixteen after its
 * prefix.
 */
function redactKeyish(text) {
  return String(text == null ? '' : text)
    // A prefix plus a long tail is not enough on its own -- "api-versioning-
    // strategy" is prose. A key's tail carries digits or masking asterisks,
    // or runs longer than any hyphenated phrase does.
    .replace(/\b(sk|pk|api|key)[-_]([A-Za-z0-9_*-]{16,})/gi, function (whole, prefix, tail) {
      return (/[0-9*]/.test(tail) || tail.length >= 32) ? '[redacted]' : whole;
    })
    .replace(/\*{8,}/g, '[redacted]');
}

/**
 * Headers every response carries.
 *
 * None of these were sent. The page is served to one browser on
 * one machine, so the exposure is small; the cost of the headers is smaller.
 * The content-security policy goes on the HTML alone -- it is the document's
 * policy -- and allows exactly what index.html loads: React from unpkg, the
 * app's own script, inline styles (React writes style attributes), and images
 * over https for the logos some views show.
 */
const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

function withBase(headers) {
  return Object.assign({}, BASE_HEADERS, headers || {});
}

/**
 * Compression, from Node's own zlib.
 *
 * Nothing was compressed: the portfolio tracker's build/app.js went out as a
 * megabyte on every visit (7.4 s to the first frame on Fast 3G), and the
 * calendar's first load was 13 MB of uncompressed JSON from the API route.
 * Text answers over a kilobyte are sent as Brotli or gzip, whichever the
 * browser accepts (Brotli first); images and small answers as they are.
 */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg\+xml)/i;
const MIN_COMPRESS_BYTES = 1024;

/** The browser's Accept-Encoding as { name: q }. */
function acceptedEncodings(header) {
  const out = {};
  String(header || '').split(',').forEach(function (part) {
    const bits = part.split(';');
    const name = bits[0].trim().toLowerCase();
    if (!name) return;
    let q = 1;
    bits.slice(1).forEach(function (p) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    });
    out[name] = q;
  });
  return out;
}

/** 'br', 'gzip' or null: what this answer may be sent as. */
function pickEncoding(req) {
  const accepted = acceptedEncodings(req && req.headers && req.headers['accept-encoding']);
  const ok = function (name) {
    if (Object.prototype.hasOwnProperty.call(accepted, name)) return accepted[name] > 0;
    return Object.prototype.hasOwnProperty.call(accepted, '*') && accepted['*'] > 0;
  };
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

function compressBody(buf, encoding) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
  }
  return zlib.gzipSync(buf, { level: 6 });
}

/** Whether an answer of this type and size is worth compressing. */
function compressible(contentType, length) {
  return COMPRESSIBLE.test(String(contentType || '')) && length >= MIN_COMPRESS_BYTES;
}

/** POST a chat completion. OpenAI-shaped, which most providers now speak. */
function fetchAI(url, payload, key, timeoutMs) {
  const deadline = timeoutMs || AI_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: 'Bearer ' + key,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.setTimeout(deadline, () => {
      const err = new Error('the AI provider did not answer within ' + (deadline / 1000) + ' seconds');
      err.timeout = true;
      req.destroy(err);
    });
    req.end(body);
  });
}

/**
 * The request body, up to a limit. Past it, rejects with `tooLarge` and stops
 * buffering.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let text = '';
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (limit && size > limit) {
        done = true;
        const err = new Error('request body too large');
        err.tooLarge = true;
        reject(err);
        return;
      }
      text += c;
    });
    req.on('end', () => { if (!done) { done = true; resolve(text); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

/**
 * Refuse a request another site's page made.
 *
 * The Host check stops DNS rebinding, not this: any page open in the same
 * browser can send a "simple" request to http://localhost:5173 -- an <img>, a
 * form, a no-cors text/plain POST -- and the browser sends the right Host with
 * it. The page cannot read the answer and does not need to: the request itself
 * spends the developer's EODHD quota and model tokens (shown with a page on
 * another origin posting a prompt to /api/_ai/chat).
 *
 * Browsers say where a request came from, and the rule is an allowlist:
 * Sec-Fetch-Site must be 'same-origin' (this app's own page) or 'none' (an
 * address typed or bookmarked). 'same-site' is refused too -- a page served
 * from ANOTHER localhost port is same-site, and its <img src="/api/eod/...">
 * carries no Origin, so a blocklist of 'cross-site' let it spend the quota.
 * Origin, when present, must be this server. A
 * request with neither header -- curl, a script -- is not a browser acting
 * for somebody else's page.
 */
function crossSite(req) {
  const h = req.headers || {};
  const site = h['sec-fetch-site'] == null ? null : String(h['sec-fetch-site']).toLowerCase();
  if (site !== null && site !== 'same-origin' && site !== 'none') return true;
  if (h.origin == null) return false;
  return String(h.origin).toLowerCase() !== 'http://' + String(h.host || '').toLowerCase();
}

// Upstream answers are data for the page's fetch() calls, never documents. An
// eodhd.com error page is the full site with its own scripts, and opened
// directly it ran on this origin, beside a proxy that signs requests.
const API_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";

/** The campaign tag for links out of this app: its name, from package.json. */
function campaignOf(root) {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name || '';
    return String(name).replace(/^eodhd-/, '') || 'app';
  } catch (_) {
    return 'app';
  }
}

function registerUrl(root) {
  return 'https://eodhd.com/register?utm_source=eodhd_oss&utm_medium=app&utm_campaign='
    + encodeURIComponent(campaignOf(root)) + '&utm_content=console';
}

/**
 * Whether a page on eodhd.com exists: a HEAD, no key, no redirects followed.
 * true for a 200, false for any other answer, null when there was no answer
 * -- the site did not reply in time or could not be reached, which says
 * nothing about the page.
 *
 * The deadline is long because the site is slow to answer for some pages:
 * measured 2 Oct 2026, a HEAD took between 0.6 and 12.8 seconds, for pages
 * that exist and pages that do not alike. At five seconds NVDA.US was reported
 * missing and its tile opened the US exchange page instead.
 */
const PAGE_PROBE_TIMEOUT_MS = 15000;
function probePage(pagePath) {
  return new Promise((resolve) => {
    const req = https.request(UPSTREAM + pagePath, { method: 'HEAD' }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(null));
    req.setTimeout(PAGE_PROBE_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Answers kept for a while: the same few symbols get clicked again, and each
// probe is a request to somebody else's site. Bounded so a long session
// cannot grow it without limit. Only real answers are kept: a timeout is
// asked again on the next click.
const PAGE_CACHE_MS = 6 * 3600 * 1000;
const PAGE_CACHE_MAX = 1000;
const pageCache = new Map();

async function pageExists(pagePath, probe) {
  const hit = pageCache.get(pagePath);
  if (hit && Date.now() - hit.at < PAGE_CACHE_MS) return hit.ok;
  const answer = await probe(pagePath);
  if (answer !== true && answer !== false) return null;
  if (pageCache.size >= PAGE_CACHE_MAX) pageCache.clear();
  pageCache.set(pagePath, { ok: answer, at: Date.now() });
  return answer;
}

// The last resort: eodhd.com's list of the exchanges it covers. Always there,
// and the place to go on from when a symbol has no page of its own.
const FALLBACK_PAGE = '/list-of-stock-markets';

/**
 * The page a clicked symbol opens: its own financial summary when eodhd.com
 * has one, else its exchange's page, else the list of exchanges.
 *
 * It cannot be worked out from the symbol. The views link every row to
 * /financial-summary/<SYMBOL>, and that page exists for AAPL.US, BMW.XETRA and
 * NESN.SW but answers 404 for every LSE, HK, NSE and TSE symbol tried, for
 * .INDX, and for some symbols on exchanges where others work (ROG.SW, BMW.HA)
 * -- measured again on 2 Oct 2026. A list of good exchanges would
 * still send people to dead pages, and go stale the day the site changes; a
 * HEAD at click time does neither.
 */
async function pageFor(rawSymbol, probe) {
  let symbol = String(rawSymbol == null ? '' : rawSymbol).trim().toUpperCase();
  // Letters, digits, dot, dash, underscore: every EODHD code. Anything else
  // is not probed -- this request goes out under the developer's IP.
  if (!/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(symbol)) return { path: FALLBACK_PAGE, exact: false };
  if (symbol.indexOf('.') === -1) symbol += '.US';
  const own = '/financial-summary/' + symbol;
  const exchangePage = '/exchange/' + symbol.slice(symbol.lastIndexOf('.') + 1);
  // Both at once: the reader is looking at an empty tab while this runs, and
  // the site can take seconds per page. The exchange answer is cached, so it
  // costs one request per exchange, not per click.
  const [hasOwn, hasExchange] = await Promise.all([pageExists(own, probe), pageExists(exchangePage, probe)]);
  if (hasOwn) return { path: own, exact: true };
  if (hasExchange) return { path: exchangePage, exact: false };
  return { path: FALLBACK_PAGE, exact: false };
}

function createHandler(opts) {
  const key = opts.key || '';
  // A refused placeholder, kept so the page can name it. Guarded below so a
  // real key can never take this route out: only a listed placeholder or a
  // value too short to be a key ever travels in this field.
  const rawIgnored = String(opts.ignoredKey == null ? '' : opts.ignoredKey);
  const ignoredKey = (PLACEHOLDERS.includes(rawIgnored.toLowerCase()) || rawIgnored.length < MIN_KEY_LENGTH)
    ? rawIgnored : '';
  const ignoredWhy = ignoredKey
    ? (PLACEHOLDERS.includes(ignoredKey.toLowerCase()) ? 'placeholder' : 'short')
    : '';
  const aiKey = opts.aiKey || '';
  const aiBaseUrl = (opts.aiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const aiModel = opts.aiModel || 'gpt-4o-mini';
  const root = opts.root;
  const upstream = opts.fetchUpstream || fetchUpstream;
  const ai = opts.fetchAI || fetchAI;
  const secrets = [key, aiKey];
  const aiTimeoutMs = opts.aiTimeoutMs || AI_TIMEOUT_MS;
  const probe = opts.probePage || probePage;

  return async function handler(req, res) {
    if (!hostAllowed(req.headers && req.headers.host)) {
      res.writeHead(403, withBase({ 'content-type': 'text/plain; charset=utf-8' }));
      return res.end('This server answers on localhost only.');
    }
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/api/') && crossSite(req)) {
      res.writeHead(403, withBase({ 'content-type': 'text/plain; charset=utf-8' }));
      return res.end('Requests from other sites are refused: this server spends your own API quota.');
    }

    // Which eodhd.com page a clicked symbol should open. Asked by
    // shell/links.js; see pageFor() for why it cannot just be built.
    if (url.pathname === '/api/_asset-page') {
      const answer = await pageFor(url.searchParams.get('symbol'), probe);
      res.writeHead(200, withBase({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }));
      return res.end(JSON.stringify(answer));
    }

    // Free or paid, and nothing else. Asked only by an app whose first screen
    // depends on it (meta.json askPlan: the news app tracks one ticker on the
    // free tier's twenty a day, three on a paid plan). EODHD's /api/user does
    // not count against the quota -- measured on a fresh free key: one
    // sentiments request moved its counter from 0 to 5, with /api/user read
    // before and after. Its answer also carries the owner's e-mail address and
    // name, which is why /api/user is not in UPSTREAM_ALLOWED and why only the
    // one derived word leaves this server.
    if (url.pathname === '/api/_plan') {
      const plan = key ? await planOf(key, upstream) : null;
      res.writeHead(200, withBase({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }));
      return res.end(JSON.stringify({ plan }));
    }

    // Asked on every boot. Answered from configuration alone -- the free tier
    // is twenty requests a day and none of them should go on this.
    if (url.pathname === '/api/_status') {
      res.writeHead(200, withBase({ 'content-type': 'application/json; charset=utf-8' }));
      // hasAI drives whether the AI affordances render at all. An absent
      // button is better than a present one that explains it cannot work.
      const body = { hasKey: Boolean(key), hasAI: Boolean(aiKey) };
      // A tag for the key, never the key: the first 16 hex of its SHA-256.
      // The browser keeps the options chain across reloads under it, so a
      // different key -- another plan -- never reads the last one's answers.
      if (key) body.keyTag = require('node:crypto').createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
      // Only ever a placeholder -- "demo", "your_api_key_here" -- or a value
      // too short to be a key; never a key. Somebody who typed one of those
      // has configured a key as far as they are concerned, and the browser
      // used to answer them with "No API key configured", which reads as the
      // app not having noticed. The server console said the right thing; the
      // page a person is actually looking at did not.
      if (!key && ignoredKey) { body.ignoredKey = ignoredKey; body.ignoredWhy = ignoredWhy; }
      return res.end(JSON.stringify(body));
    }

    // Analysis on the developer's own model key, which lives in .env beside
    // the data key. Routing it through here rather than the browser keeps the
    // promise the rest of this server exists to make -- and api.anthropic.com
    // refuses browser calls outright anyway.
    if (url.pathname === '/api/_ai/chat') {
      if (req.method !== 'POST') {
        res.writeHead(405, withBase({ 'content-type': 'text/plain; charset=utf-8' }));
        return res.end('POST only');
      }
      if (!aiKey) {
        res.writeHead(503, withBase({ 'content-type': 'text/plain; charset=utf-8' }));
        return res.end('No AI key configured. Set OPENAI_API_KEY in .env to enable analysis.');
      }
      // JSON only. A text/plain POST is the one shape another site's page can
      // send without asking first; requiring JSON makes a browser ask (a
      // preflight OPTIONS), and the 405 above answers that with no.
      if (!/^application\/json\b/i.test(String((req.headers && req.headers['content-type']) || ''))) {
        res.writeHead(415, withBase({ 'content-type': 'text/plain; charset=utf-8' }));
        return res.end('Expected Content-Type: application/json.');
      }
      let raw;
      try {
        raw = await readBody(req, AI_BODY_LIMIT);
      } catch (e) {
        res.writeHead(e && e.tooLarge ? 413 : 400, withBase({ 'content-type': 'text/plain; charset=utf-8', connection: 'close' }));
        return res.end(e && e.tooLarge
          ? 'Request too large: the limit is ' + (AI_BODY_LIMIT / 1024) + ' KB.'
          : 'Could not read the request.');
      }
      let payload;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.messages)) throw new Error('messages must be an array');
        // Only the messages are forwarded. Anything else the page sent --
        // including a key it had no business supplying -- is dropped. The
        // model is the server's: AI_MODEL in .env, or the default. (This
        // comment used to say so while the code let the page pick one.)
        payload = { model: aiModel, messages: parsed.messages };
      } catch (e) {
        res.writeHead(400, withBase({ 'content-type': 'text/plain; charset=utf-8' }));
        return res.end('Expected JSON with a messages array.');
      }
      let answer;
      try {
        answer = await ai(aiBaseUrl + '/chat/completions', payload, aiKey, aiTimeoutMs);
      } catch (e) {
        res.writeHead(e && e.timeout ? 504 : 502, withBase({ 'content-type': 'text/plain; charset=utf-8' }));
        return res.end('Could not reach the AI provider: ' + scrub(e.message, secrets));
      }
      // Reduced to the one field the modules want, so a provider that echoes
      // the request -- key included -- has nothing to echo through. The
      // key-shaped filter runs over the answer as well as over the error: both
      // are the provider's prose.
      let content = '';
      try {
        const parsed = JSON.parse(answer.body);
        content = (parsed.choices && parsed.choices[0] && parsed.choices[0].message
          && parsed.choices[0].message.content) || '';
        if (!content && parsed.error) content = 'AI provider: ' + scrub(String(parsed.error.message || ''), secrets);
        content = redactKeyish(content);
      } catch (_) {
        content = 'AI provider returned something unreadable.';
      }
      res.writeHead(answer.status >= 500 ? 502 : 200, withBase({ 'content-type': 'application/json; charset=utf-8' }));
      return res.end(scrub(JSON.stringify({ content: content }), secrets));
    }

    if (url.pathname.startsWith('/api/')) {
      // Reads only. Everything upstream is fetched with GET, and a POST or a
      // DELETE arriving here used to be forwarded as a GET anyway -- silently
      // doing something other than what was asked.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, withBase({ 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }));
        return res.end('GET only');
      }
      if (!key) {
        res.writeHead(503, withBase({ 'content-type': 'text/plain; charset=utf-8' }));
        return res.end('No API key configured. Set EODHD_API_KEY in .env and restart.');
      }
      const target = buildUpstreamUrl(req.url, key);
      if (!target) {
        res.writeHead(404, withBase({ 'content-type': 'text/plain; charset=utf-8' }));
        return res.end('Not found');
      }
      // Morningstar's fields are not passed on: a filter that names one
      // is answered "NA" -- EODHD's word for a field that is not there --
      // without asking, and whole fundamentals lose them below.
      const fundamentals = isFundamentalsPath(target.pathname);
      if (fundamentals && target.searchParams.has('filter')) {
        // Only the Morningstar parts go: a mixed filter keeps its other
        // fields, and one with nothing else left is answered "NA".
        const parts = target.searchParams.getAll('filter').join(',').split(',').map(function (p) { return p.trim(); }).filter(Boolean);
        const kept = parts.filter(function (p) { return !asksForMorningstar(p); });
        if (kept.length !== parts.length) {
          if (!kept.length) {
            res.writeHead(200, withBase({ 'content-type': 'application/json; charset=utf-8', 'content-security-policy': API_CSP }));
            return res.end('"NA"');
          }
          target.searchParams.delete('filter');
          target.searchParams.set('filter', kept.join(','));
        }
      }
      let answer;
      try {
        answer = await upstream(target, req);
      } catch (e) {
        res.writeHead(502, withBase({ 'content-type': 'text/plain; charset=utf-8' }));
        return res.end('Could not reach eodhd.com: ' + scrub(e.message, secrets));
      }
      // Status and body pass through untouched. The body of a 403 is the only
      // thing that names the feed the plan is missing, and rewriting it into a
      // tidy JSON error would throw away the one useful sentence in it.
      const headers = withBase({
        'content-type': answer.headers['content-type'] || 'text/plain; charset=utf-8',
        'content-security-policy': API_CSP,
      });
      // How long a 429 asks to wait: the page holds its requests that long.
      if (answer.headers['retry-after']) headers['retry-after'] = String(answer.headers['retry-after']);
      let body = answer.body;
      if (fundamentals && answer.status === 200) {
        try { body = JSON.stringify(stripMorningstar(JSON.parse(body))); } catch (_) { /* not JSON: as it came */ }
      }
      body = scrub(body, secrets);
      // Compressed when the browser takes it: a calendar's first load was
      // 13 MB of JSON as it came. Scrubbed first, so the key check reads text.
      const encoding = pickEncoding(req);
      const plain = Buffer.from(body == null ? '' : String(body), 'utf8');
      headers.vary = 'Accept-Encoding';
      if (encoding && compressible(headers['content-type'], plain.length)) {
        const packed = compressBody(plain, encoding);
        headers['content-encoding'] = encoding;
        headers['content-length'] = String(packed.length);
        res.writeHead(answer.status, headers);
        return res.end(req.method === 'HEAD' ? undefined : packed);
      }
      res.writeHead(answer.status, headers);
      return res.end(body);
    }

    return serveFile(url.pathname, root, res, req);
  };
}

/**
 * What the browser is allowed to fetch.
 *
 * An allowlist, not a blocklist. This used to serve any file inside the app
 * directory, and the only check was that the path did not escape it -- which
 * `.env` never needed to do, because it lives inside. `GET /.env` returned
 * both keys. So did `/.git/config` and `/server/proxy.js`.
 *
 * That is the exact opposite of what every other line here is for, and of what
 * the README, the key gate and this file's own header promise. Found in
 * testing with the keys read off a LAN address.
 *
 * A blocklist of dotfiles and `server/` would have closed the reported holes
 * and left the next one open. These three are everything the page loads.
 */
function isServable(rel) {
  if (rel === 'index.html') return true;
  if (rel === 'build/app.js') return true;
  // The README's screenshot, so the repo renders on GitHub and locally alike.
  if (/^docs\/[A-Za-z0-9._-]+\.(png|jpe?g|gif|svg)$/.test(rel)) return true;
  return false;
}

/**
 * How long the browser may keep a file without asking.
 *
 * index.html and build/app.js keep their names from one build to the next, so
 * they are never kept unasked: "no-cache" means "ask first", and the ETag
 * makes the asking cheap -- an unchanged file is a 304 with no body. Neither
 * was cached at all, and a repeat visit downloaded the whole bundle again (7.1
 * s on Fast 3G). A file whose name carries its content hash would be kept a
 * year ("immutable"); this build writes none. The README's images may be kept
 * a day.
 */
function cacheControlFor(rel) {
  if (/[.-][0-9a-f]{8,}\.(js|css)$/i.test(rel)) return 'public, max-age=31536000, immutable';
  if (/^docs\//.test(rel)) return 'public, max-age=86400';
  return 'no-cache';
}

// A file read once per change: its bytes, its ETag, and each compressed form
// as it is first asked for.
const fileCache = new Map();

function readServable(file, cb) {
  fs.stat(file, (statErr, st) => {
    if (statErr || !st.isFile()) return cb(statErr || new Error('not a file'));
    const hit = fileCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return cb(null, hit);
    fs.readFile(file, (err, data) => {
      if (err) return cb(err);
      const entry = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        data,
        etag: crypto.createHash('sha1').update(data).digest('base64url').slice(0, 27),
        lastModified: new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString(),
        encoded: {},
      };
      fileCache.set(file, entry);
      cb(null, entry);
    });
  });
}

/**
 * Whether the browser's copy is the one this answer would send
 * (If-None-Match, else If-Modified-Since). A tag names one representation:
 * the gzip copy's tag does not stand for the Brotli or the plain one.
 */
function notModified(req, entry, etag) {
  const h = (req && req.headers) || {};
  const inm = h['if-none-match'];
  if (inm) {
    return String(inm).split(',').some(function (t) {
      const tag = t.trim().replace(/^W\//, '');
      return tag === '*' || tag === etag;
    });
  }
  const ims = Date.parse(h['if-modified-since'] || '');
  return Number.isFinite(ims) && Math.floor(entry.mtimeMs / 1000) * 1000 <= ims;
}

function serveFile(pathname, root, res, req) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!isServable(rel)) {
    res.writeHead(404, withBase({ 'content-type': 'text/plain; charset=utf-8' }));
    return res.end('Not found');
  }
  const file = path.join(root, rel);
  // Belt as well as braces: the allowlist already forbids traversal, but a
  // future entry with a wildcard should not be the thing that reopens it.
  if (!file.startsWith(path.resolve(root))) {
    res.writeHead(403, withBase()); return res.end('Forbidden');
  }
  readServable(file, (err, entry) => {
    if (err) { res.writeHead(404, withBase()); return res.end('Not found'); }
    const ext = path.extname(file);
    const type = MIME[ext] || 'application/octet-stream';
    const headers = withBase({ 'content-type': type, 'cache-control': cacheControlFor(rel), 'last-modified': entry.lastModified });
    if (ext === '.html') headers['content-security-policy'] = CSP;
    const zip = compressible(type, entry.data.length);
    const encoding = zip ? pickEncoding(req) : null;
    if (zip) headers.vary = 'Accept-Encoding';
    // One tag per representation: the Brotli copy is not the gzip copy.
    headers.etag = '"' + entry.etag + (encoding === 'br' ? '-br' : encoding === 'gzip' ? '-gz' : '') + '"';
    if (notModified(req, entry, headers.etag)) {
      res.writeHead(304, headers);
      return res.end();
    }
    let body = entry.data;
    if (encoding) {
      if (!entry.encoded[encoding]) entry.encoded[encoding] = compressBody(entry.data, encoding);
      body = entry.encoded[encoding];
      headers['content-encoding'] = encoding;
    }
    headers['content-length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(req && req.method === 'HEAD' ? undefined : body);
  });
}

/**
 * Refuse a request that arrived under someone else's name.
 *
 * Binding to loopback stops the neighbour on the network. It does not stop DNS
 * rebinding: a page on evil.com whose domain resolves to 127.0.0.1 reaches this
 * server from the victim's own browser, and the browser sends `Host: evil.com`.
 * Checking the header is what closes that, and it costs one comparison.
 */
function hostAllowed(hostHeader) {
  const host = String(hostHeader || '').split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * Why a PORT value cannot be listened on, or null when it can. Only whole
 * numbers in node's range; 0 stays allowed, it is how a harness asks for any
 * free port. Ports below 1024 are not refused here -- Windows opens them to
 * anybody -- and the EACCES they give elsewhere is explained where it happens.
 */
function portProblem(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(text)) return 'which is not a port number';
  if (Number(text) > 65535) return 'which is past the last port there is (65535)';
  return null;
}

/**
 * How to pick another port, said for where PORT came from. The environment
 * wins over .env (start() below), so telling somebody whose shell sets PORT to
 * "add PORT=5174 to .env" sent them to edit a file that is never read for it.
 * The suggestion is a port that is not the one that just failed.
 */
function portAdvice(from, port) {
  const next = Number(port) === 5174 ? 5175 : 5174;
  if (from === 'the environment') {
    return 'PORT comes from your environment, which wins over .env: set it to another number (for example  PORT=' + next + ' ) or remove it, then npm start again.';
  }
  if (from === '.env') return 'Change the PORT line in .env to another number (for example  PORT=' + next + ' ), then npm start again.';
  return 'Start on another one: add the line  PORT=' + next + '  to .env, then npm start again.';
}

function start(opts) {
  const root = (opts && opts.root) || process.cwd();
  // `||` would swallow 0, which is the standard way to ask for any free port
  // and the only sane thing for a harness to pass.
  let env = {};
  try { env = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')); } catch (_) { /* no .env yet */ }
  // The environment, then .env, then the default. .env is the one way to set
  // it that works the same in bash, cmd and PowerShell -- `PORT=5174 npm
  // start` is POSIX shell syntax and fails in the other two, and that is what
  // the busy-port hint used to tell everybody to type.
  const from = (opts && opts.port != null) ? null
    : (process.env.PORT != null && process.env.PORT !== '') ? 'the environment'
    : (env.PORT != null && env.PORT !== '') ? '.env'
    : null;
  const requested = (opts && opts.port != null) ? opts.port
    : from === 'the environment' ? process.env.PORT
    : from === '.env' ? env.PORT
    : 5173;
  // Checked before listen(). `PORT=abc` and `PORT=99999` reached it as they
  // were and node answered with RangeError [ERR_SOCKET_BAD_PORT] and a stack
  // -- while a busy port, the same mistake one step later, got a sentence
  // and a fix.
  const bad = portProblem(requested);
  if (bad) {
    console.error('PORT is set to "' + String(requested) + '"' + (from ? ' (in ' + from + ')' : '') + ', ' + bad + '.');
    console.error('Use a whole number between 1024 and 65535. ' + portAdvice(from, null));
    process.exit(1);
    return null;
  }
  const port = Number(requested);

  // The placeholder filter has to apply to the environment variable too.
  // It only covered .env at first, so `EODHD_API_KEY=demo npm start` sailed
  // past the check that exists to stop exactly that -- and the path a stranger
  // takes was not the path being tested.
  let key = process.env.EODHD_API_KEY || env.EODHD_API_KEY || '';
  let ignoredKey = env.EODHD_API_KEY_RAW || '';
  if (PLACEHOLDERS.includes(String(key).toLowerCase())) { ignoredKey = key || ignoredKey; key = ''; }
  // Too short to be a key: refused for the same reason a placeholder is, and
  // named back to the reader the same way.
  if (key && key.length < MIN_KEY_LENGTH) { ignoredKey = key; key = ''; }
  // Optional throughout. Without it the apps work completely and the AI
  // affordances are simply absent.
  const aiKey = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || '';

  const server = http.createServer(createHandler({
    key: key,
    ignoredKey: ignoredKey,
    aiKey: aiKey,
    aiBaseUrl: process.env.AI_BASE_URL || env.AI_BASE_URL,
    aiModel: process.env.AI_MODEL || env.AI_MODEL,
    root: root,
  }));

  // 5173 is Vite's default port, so a front-end developer trying this out is
  // reasonably likely to have something on it already. Unhandled, node prints
  // ten lines of stack trace at somebody who has been using the thing for
  // ninety seconds.
  server.on('error', function (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error('Port ' + port + ' is already in use.');
      // Only 5173 is Vite's; on any other port the sentence was simply untrue.
      console.error(port === 5173 ? 'Something else is running there — Vite uses this port by default.' : 'Something else is running there.');
      console.error(portAdvice(from, port));
      process.exit(1);
      // Explicit, rather than relying on exit never returning. It does not in
      // production; under test it does, and without this the next line rethrew
      // the very error we had just explained.
      return;
    }
    // PORT=80 on macOS or Linux: ports below 1024 belong to the system. This
    // printed "Error: listen EACCES" and a stack.
    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      console.error('Port ' + port + ' is not open to this user — ports below 1024 usually need administrator rights.');
      console.error(portAdvice(from, port));
      process.exit(1);
      return;
    }
    // Anything else still gets a sentence rather than a stack: the reader is
    // somebody running a sample app, not somebody debugging node.
    console.error('The server could not start on port ' + port + ': ' + ((err && err.message) || err) + '.');
    process.exit(1);
  });
  // Loopback, not every interface. It listened on 0.0.0.0, so anyone on the
  // same network could read the app -- and, before the allowlist above, its
  // .env. A sample app on a developer's laptop has no reason to be reachable
  // from the coffee-shop wifi.
  server.listen(port, '127.0.0.1', () => {
    // The port actually bound: PORT=0 asks for any free one, and the line
    // read "http://localhost:0".
    const bound = (server.address() && server.address().port) || port;
    console.log('Running on http://localhost:' + bound);
    if (!key) {
      // Placeholders are read as unset on purpose -- "demo" in particular,
      // because it is the one value that would quietly bring back the demo
      // mode this project decided against. But somebody who typed it has
      // configured a key as far as they are concerned, and "no key set" reads
      // as the app not having noticed. Say which value was ignored and why.
      // ignoredKey, not the .env field alone: `EODHD_API_KEY=demo npm start`
      // used to print "No EODHD_API_KEY set yet" while the page correctly
      // explained the refusal.
      var raw = String(ignoredKey || '').trim();
      if (raw && raw.length < MIN_KEY_LENGTH && !PLACEHOLDERS.includes(raw.toLowerCase())) {
        console.log('EODHD_API_KEY is set to "' + raw + '", which is too short to be an EODHD key');
        console.log('(they are twenty-odd characters). Check .env and restart.');
      } else if (raw) {
        console.log('EODHD_API_KEY is set to "' + raw + '", which this app treats as unset.');
        console.log('Placeholders and the public "demo" token are refused: these apps run on');
        console.log('your own key, and a shared one would only show you somebody else\'s plan.');
        console.log('Get one at ' + registerUrl(root));
      } else {
        console.log('No EODHD_API_KEY set yet - the page will tell you what to do.');
      }
    }
    if (!aiKey) console.log('No OPENAI_API_KEY set - AI analysis is off. Everything else works.');
  });
  return server;
}

module.exports = {
  parseEnv, buildUpstreamUrl, fetchUpstream, fetchAI, createHandler, scrub, redactKeyish, planFromUser,
  isServable, hostAllowed, crossSite, readBody, registerUrl, start, portProblem, portAdvice, pageFor, pageCache, AI_BODY_LIMIT,
  stripMorningstar, asksForMorningstar, isFundamentalsPath, upstreamTimeoutMs,
  acceptedEncodings, pickEncoding, cacheControlFor,
};

if (require.main === module) start({ root: path.join(__dirname, '..') });
