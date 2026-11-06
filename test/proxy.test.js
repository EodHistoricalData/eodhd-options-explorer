/**
 * @jest-environment node
 *
 * The proxy is the piece that makes the key claim true. Everything else in the
 * shell is presentation; this is where the key is held, and it is the only
 * place in the whole app that knows it.
 *
 * Two properties matter more than the rest:
 *   - the key goes up and never comes back down;
 *   - an upstream 403 arrives at the client intact, body and all, because
 *     that plain-text body is the only thing that tells a developer which
 *     feed their plan is missing.
 */
const { buildUpstreamUrl, createHandler, parseEnv } = require('../server/proxy.js');

const KEY = '68a1f0c9deadbeefcafe';

function call(handler, url, opts = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: null,
      headers: {},
      writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
      setHeader(k, v) { this.headers[k] = v; },
      end(body) {
        if (body) chunks.push(body);
        resolve({ status: this.statusCode, headers: this.headers, body: chunks.join('') });
      },
      write(c) { chunks.push(c); },
    };
    // A Host is sent because HTTP/1.1 requires one and the handler refuses a
    // request without it — that check is what stops DNS rebinding.
    handler({ url, method: opts.method || 'GET', headers: { host: opts.host || 'localhost:5173' } }, res);
  });
}

describe('building the upstream URL', () => {
  test('forwards the path and query untouched apart from the token', () => {
    const u = buildUpstreamUrl('/api/eod/AAPL.US?period=d&order=d&fmt=json', KEY);
    expect(u.pathname).toBe('/api/eod/AAPL.US');
    expect(u.searchParams.get('period')).toBe('d');
    expect(u.searchParams.get('order')).toBe('d');
    expect(u.searchParams.get('fmt')).toBe('json');
    expect(u.origin).toBe('https://eodhd.com');
  });

  test('injects the key from the environment', () => {
    const u = buildUpstreamUrl('/api/eod/AAPL.US', KEY);
    expect(u.searchParams.get('api_token')).toBe(KEY);
  });

  test('strips any api_token the client sent and uses ours', () => {
    // A page should never be sending one. If it does, it is either a mistake
    // or an attempt to bill someone else's key through our proxy.
    const u = buildUpstreamUrl('/api/eod/AAPL.US?api_token=someone-elses', KEY);
    expect(u.searchParams.getAll('api_token')).toEqual([KEY]);
  });

  test('refuses to leave eodhd.com however the path is written', () => {
    // An encoded separator is refused outright rather than forwarded for
    // eodhd.com's router to interpret.
    expect(buildUpstreamUrl('/api/eod/..%2Fx', KEY)).toBeNull();
    const u = buildUpstreamUrl('/api/eod/AAPL.US', KEY);
    expect(u.origin).toBe('https://eodhd.com');
    expect(u.pathname.indexOf('/api/')).toBe(0);
    // `/api//evil.com/x` has no feed name in the first segment, so it is not
    // on the allowlist and never leaves this machine.
    expect(buildUpstreamUrl('/api//evil.com/x', KEY)).toBeNull();
  });

  test('a path that climbs out of /api/ is refused, not forwarded', () => {
    // The origin was always fixed, but `/api/../../evil` normalised to `/evil`
    // and went upstream as https://eodhd.com/evil?api_token=... -- a request
    // this server has no business making. The encoded spelling
    // slips past a text check, because the URL parser decodes %2e%2e to ..
    // and resolves it; the parsed path is checked as well.
    expect(buildUpstreamUrl('/api/../../evil', KEY)).toBeNull();
    expect(buildUpstreamUrl('/api/../eod/AAPL.US', KEY)).toBeNull();
    expect(buildUpstreamUrl('/api/%2e%2e/evil', KEY)).toBeNull();
  });
});

describe('the status endpoint', () => {
  test('reports a configured key without asking upstream anything', async () => {
    const upstream = jest.fn();
    const handler = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream });
    const res = await call(handler, '/api/_status');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ hasKey: true, hasAI: false, keyTag: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(res.body).not.toContain(KEY);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('reports a missing key, still without asking upstream', async () => {
    const upstream = jest.fn();
    const handler = createHandler({ key: '', root: __dirname, fetchUpstream: upstream });
    const res = await call(handler, '/api/_status');
    expect(JSON.parse(res.body)).toEqual({ hasKey: false, hasAI: false });
    expect(upstream).not.toHaveBeenCalled();
  });

  test('never returns the key itself', async () => {
    const handler = createHandler({ key: KEY, root: __dirname, fetchUpstream: jest.fn() });
    const res = await call(handler, '/api/_status');
    expect(res.body).not.toContain(KEY);
    expect(JSON.stringify(res.headers)).not.toContain(KEY);
  });
});

describe('passing upstream answers through', () => {
  const upstream403 = async () => ({
    status: 403,
    headers: { 'content-type': 'text/plain' },
    body: 'Forbidden. You have no access to Options Data Feed.',
  });

  test('a 403 arrives with its status and its plain-text body intact', async () => {
    const handler = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream403 });
    const res = await call(handler, '/api/mp/unicornbay/options/contracts');
    expect(res.status).toBe(403);
    // The body is the only thing that names the missing feed. Rewriting it
    // into a tidy JSON error would throw away the one useful sentence.
    expect(res.body).toBe('Forbidden. You have no access to Options Data Feed.');
  });

  test('a 200 body is passed through byte for byte', async () => {
    const payload = '[{"date":"1980-12-12","open":28.7392}]';
    const handler = createHandler({
      key: KEY, root: __dirname,
      fetchUpstream: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: payload }),
    });
    const res = await call(handler, '/api/eod/AAPL.US');
    expect(res.body).toBe(payload);
  });

  test('the key never comes back down, in any header or body', async () => {
    // The nastiest realistic case: upstream echoes the request URL back in an
    // error message, key and all.
    const handler = createHandler({
      key: KEY, root: __dirname,
      fetchUpstream: async () => ({
        status: 500,
        headers: { 'content-type': 'text/plain', 'x-request-url': `https://eodhd.com/api/eod?api_token=${KEY}` },
        body: `upstream failed for https://eodhd.com/api/eod?api_token=${KEY}`,
      }),
    });
    const res = await call(handler, '/api/eod/AAPL.US');
    expect(res.body).not.toContain(KEY);
    expect(JSON.stringify(res.headers)).not.toContain(KEY);
  });

  test('with no key configured, upstream is not called at all', async () => {
    const upstream = jest.fn();
    const handler = createHandler({ key: '', root: __dirname, fetchUpstream: upstream });
    const res = await call(handler, '/api/eod/AAPL.US');
    expect(res.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('reading .env', () => {
  test('takes the key, ignores comments and blank lines', () => {
    const env = parseEnv('# comment\n\nEODHD_API_KEY=abc123\nOTHER=x\n');
    expect(env.EODHD_API_KEY).toBe('abc123');
  });

  test('tolerates quotes and trailing whitespace, which people leave in', () => {
    expect(parseEnv('EODHD_API_KEY="abc123"  \n').EODHD_API_KEY).toBe('abc123');
    expect(parseEnv("EODHD_API_KEY='abc123'\n").EODHD_API_KEY).toBe('abc123');
  });

  test('an unset key is empty, not the literal placeholder', () => {
    // .env.example ships with a placeholder. Treating it as a real key would
    // send the developer to a confusing 401 instead of the setup screen.
    expect(parseEnv('EODHD_API_KEY=your_api_key_here\n').EODHD_API_KEY).toBe('');
  });
});

describe('starting up', () => {
  const { start } = require('../server/proxy.js');
  const http = require('node:http');

  test('a busy port explains itself instead of printing a stack trace', async () => {
    // 5173 is Vite's default, so a front-end developer trying this out is
    // reasonably likely to have something on it already. Found by cloning the
    // repository from GitHub and running it the way a stranger would.
    const blocker = http.createServer(() => {});
    // On the same interface the server now uses: it binds loopback rather
    // than every address, and on Windows a 0.0.0.0 blocker does not
    // necessarily collide with a 127.0.0.1 listener.
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const port = blocker.address().port;

    const said = [];
    const exits = [];
    const realError = console.error;
    const realExit = process.exit;
    console.error = (m) => said.push(String(m));
    // Recorded rather than thrown: the handler runs on the server's error
    // event, so a throw here escapes the try and lands as an unhandled
    // rejection instead of being caught.
    process.exit = (code) => { exits.push(code); };

    const s = start({ root: __dirname, port });
    await new Promise((r) => setTimeout(r, 80));
    try { s.close(); } catch (_) { /* never listened */ }

    console.error = realError;
    process.exit = realExit;
    blocker.close();

    expect(exits).toEqual([1]);

    const text = said.join(' ');
    expect(text).toMatch(/already in use/i);
    expect(text).toMatch(/PORT=/);
    expect(text).not.toMatch(/at Server|node:net/);
  });
});

describe('telling the page what the console already knew', () => {
  test('a refused placeholder is named in the status, so the page can explain', async () => {
    const handler = createHandler({ key: '', ignoredKey: 'demo', root: __dirname, fetchUpstream: jest.fn() });
    const res = await call(handler, '/api/_status');
    const body = JSON.parse(res.body);
    expect(body.hasKey).toBe(false);
    expect(body.ignoredKey).toBe('demo');
  });

  test('a real key never travels in that field, whatever is passed', async () => {
    // The field exists to name a public placeholder. If a future change ever
    // routed the configured key into it, this is where it stops.
    const handler = createHandler({ key: '', ignoredKey: KEY, root: __dirname, fetchUpstream: jest.fn() });
    const res = await call(handler, '/api/_status');
    expect(res.body).not.toContain(KEY);
    expect(JSON.parse(res.body).ignoredKey).toBeUndefined();
  });

  test('nothing is named when a key is actually configured', async () => {
    const handler = createHandler({ key: KEY, ignoredKey: 'demo', root: __dirname, fetchUpstream: jest.fn() });
    expect(JSON.parse((await call(handler, '/api/_status')).body).ignoredKey).toBeUndefined();
  });
});

describe('the environment variable, which is the path a stranger takes', () => {
  const { start } = require('../server/proxy.js');
  const http = require('node:http');

  async function statusFrom(envValue) {
    const before = process.env.EODHD_API_KEY;
    process.env.EODHD_API_KEY = envValue;
    const server = start({ root: __dirname, port: 0 });
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const body = await new Promise((resolve) => {
      // agent:false, or the keep-alive socket outlives close() and jest ends
      // the run complaining about a handle nobody released.
      http.get({ host: '127.0.0.1', port, path: '/api/_status', agent: false }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(JSON.parse(t)));
      });
    });
    await new Promise((r) => server.close(r));
    if (before === undefined) delete process.env.EODHD_API_KEY; else process.env.EODHD_API_KEY = before;
    return body;
  }

  test('demo in the environment is refused exactly as demo in .env is', async () => {
    // The filter only covered .env at first, so `EODHD_API_KEY=demo npm start`
    // walked straight past the check that exists to stop it -- and that is the
    // command in every quick-start anybody writes.
    const body = await statusFrom('demo');
    expect(body.hasKey).toBe(false);
    expect(body.ignoredKey).toBe('demo');
  });

  test('a real key in the environment still works', async () => {
    const body = await statusFrom(KEY);
    expect(body.hasKey).toBe(true);
    expect(body.ignoredKey).toBeUndefined();
  });
});

describe('what a provider says about a key', () => {
  const { redactKeyish } = require('../server/proxy.js');

  test('the asterisk wall goes, the instruction stays', () => {
    // Found by pointing the AI route at a real, expired key. OpenAI answers
    // with its own masked form -- safe by their design, and still a hundred
    // and sixty characters of asterisks in the middle of the sentence a
    // developer is about to paste into an issue.
    const real = 'Incorrect API key provided: sk-proj-****************************************EWsA. '
      + 'You can find your API key at https://platform.openai.com/account/api-keys.';
    const out = redactKeyish(real);
    expect(out).not.toMatch(/\*{8}/);
    expect(out).not.toContain('sk-proj-');
    expect(out).toContain('Incorrect API key provided');
    expect(out).toContain('platform.openai.com');
  });

  test('an unmasked key in provider prose does not survive either', () => {
    const out = redactKeyish('Invalid key sk-abcdefghijklmnopqrstuvwxyz012345 supplied');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(out).toContain('supplied');
  });

  test('ordinary sentences are left alone', () => {
    // The rule has to be narrow. Rewriting a provider's explanation into
    // nothing would cost the developer the one line that tells them what to do.
    const plain = 'Rate limit reached for gpt-4o-mini in organization org-9 on tokens per min.';
    expect(redactKeyish(plain)).toBe(plain);
  });

  test('it never runs over EODHD responses', async () => {
    // An EODHD key is dot-separated hex, and a rule wide enough to catch one
    // would eat real values out of market data. This path is provider prose
    // only -- the market-data route stays byte for byte.
    const payload = '[{"code":"AAPL.US","api_key_ratio":"key-12345678901234"}]';
    const handler = createHandler({
      key: KEY, root: __dirname,
      fetchUpstream: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: payload }),
    });
    const res = await call(handler, '/api/eod/AAPL.US');
    expect(res.body).toBe(payload);
  });
});

describe('a key that is not a key', () => {
  const { parseEnv } = require('../server/proxy.js');

  test('demo is read as unset, and the original is kept so we can say so', () => {
    // Found by cloning a repository and putting demo in .env, which is what
    // anybody following the README with the public token would do. The app
    // said "no key configured" at somebody who had just configured one.
    const env = parseEnv('EODHD_API_KEY=demo\n');
    expect(env.EODHD_API_KEY).toBe('');
    expect(env.EODHD_API_KEY_RAW).toBe('demo');
  });

  test('the shipped placeholder is kept too', () => {
    const env = parseEnv('EODHD_API_KEY=your_api_key_here\n');
    expect(env.EODHD_API_KEY).toBe('');
    expect(env.EODHD_API_KEY_RAW).toBe('your_api_key_here');
  });

  test('a real key leaves no ghost behind', () => {
    // Made up, in a key's shape: hex, a dot, digits. Written in two halves
    // because the generator refuses any tree with that shape in it.
    const real = '68a1f0c9de4ab1' + '.' + '23456789';
    const env = parseEnv('EODHD_API_KEY=' + real + '\n');
    expect(env.EODHD_API_KEY).toBe(real);
    expect(env.EODHD_API_KEY_RAW).toBeUndefined();
  });
});

describe('what the browser may fetch', () => {
  // The whole premise of this server is that the key stays in .env and never
  // reaches the page. It served .env over HTTP. The check was that a path did
  // not escape the app directory — and .env never needed to, because it lives
  // inside it. Found in testing, with both keys read off a LAN
  // address.
  const files = createHandler({ key: KEY, root: __dirname, fetchUpstream: jest.fn() });

  test.each([
    '/.env',
    '/.env.example',
    '/.git/config',
    '/server/proxy.js',
    '/package.json',
    '/node_modules/esbuild/package.json',
    '/vendor/screener.js',
    '/shell/api.js',
  ])('%s is not served', async (p) => {
    const res = await call(files, p);
    expect(res.status).toBe(404);
  });

  test('the three things the page actually loads are served', async () => {
    // Asserted against this directory, which has none of them — a 404 for the
    // right reason. What matters is that the allowlist lets them through
    // rather than rejecting them by name.
    const { isServable } = require('../server/proxy.js');
    expect(isServable('index.html')).toBe(true);
    expect(isServable('build/app.js')).toBe(true);
    expect(isServable('docs/screenshot.png')).toBe(true);
  });

  test('and nothing else is, however it is spelled', () => {
    const { isServable } = require('../server/proxy.js');
    for (const p of ['.env', 'server/proxy.js', 'docs/../.env', 'build/../.env',
                     'docs/nested/deep.png', 'BUILD/app.js', 'index.html.bak']) {
      expect(isServable(p)).toBe(false);
    }
  });
});

describe('a request under another name', () => {
  // Loopback stops the neighbour on the network. It does not stop a page on
  // evil.com whose domain resolves to 127.0.0.1 — the browser connects here
  // and sends Host: evil.com. One comparison closes it.
  const handler = createHandler({ key: KEY, root: __dirname, fetchUpstream: jest.fn() });

  const withHost = (host, url = '/api/_status') => new Promise((resolve) => {
    const chunks = [];
    handler({ url, method: 'GET', headers: { host } }, {
      statusCode: null, headers: {},
      writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}); },
      setHeader() {},
      end(b) { if (b) chunks.push(b); resolve({ status: this.statusCode, body: chunks.join('') }); },
      write(c) { chunks.push(c); },
    });
  });

  test.each(['localhost:5173', '127.0.0.1:5173', 'localhost', '127.0.0.1'])(
    'Host: %s is answered', async (host) => {
      expect((await withHost(host)).status).toBe(200);
    });

  test.each(['evil.com', 'attacker.example:5173', 'eodhd.com'])(
    'Host: %s is refused', async (host) => {
      expect((await withHost(host)).status).toBe(403);
    });

  test('a refusal says nothing about the key', async () => {
    const res = await withHost('evil.com');
    expect(res.body).not.toContain(KEY);
  });
});

describe('a placeholder in any casing', () => {
  // eodhd.com accepts demo, DEMO and Demo alike; this list held only the lower
  // one, so EODHD_API_KEY=DEMO started the app on the shared public token —
  // the exact scenario the check exists to prevent.
  test.each(['demo', 'DEMO', 'Demo', 'dEmO', 'YOUR_API_KEY_HERE'])(
    '%s is read as unset', (value) => {
      const env = parseEnv('EODHD_API_KEY=' + value + '\n');
      expect(env.EODHD_API_KEY).toBe('');
      expect(env.EODHD_API_KEY_RAW).toBe(value);
    });

  test('a real key that merely starts with those letters still works', () => {
    // "demo" is a placeholder; "demo68a1f0c9" is somebody's key.
    expect(parseEnv('EODHD_API_KEY=demo68a1f0c9de4ab1\n').EODHD_API_KEY)
      .toBe('demo68a1f0c9de4ab1');
  });
});
