/**
 * @jest-environment node
 *
 * The smaller weaknesses testing found in the server. None of them leaked a
 * key; each of them was a place
 * where the server did something other than what was asked, quietly.
 */
const { buildUpstreamUrl, createHandler, parseEnv, scrub, redactKeyish } = require('../server/proxy.js');

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
    handler({ url, method: opts.method || 'GET', headers: { host: 'localhost:5173' } }, res);
  });
}

const ok = async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '[]' });

describe('methods', () => {
  test.each(['POST', 'PUT', 'DELETE', 'PATCH', 'TRACE'])('%s on /api/* is refused, not forwarded as GET', async (method) => {
    const upstream = jest.fn(ok);
    const handler = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream });
    const res = await call(handler, '/api/eod/AAPL.US', { method });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
    expect(upstream).not.toHaveBeenCalled();
  });

  test('GET is still forwarded', async () => {
    const upstream = jest.fn(ok);
    const handler = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream });
    expect((await call(handler, '/api/eod/AAPL.US')).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe('only the feeds these apps use are forwarded', () => {
  // The path was passed on verbatim, so GET /api/user -- which no app here
  // calls -- answered with the key owner's e-mail, plan and remaining quota
  // to anything that could reach this server.
  test.each(['/api/user', '/api/user-details', '/api/anything-else'])('%s is refused, key never sent', async (path) => {
    const upstream = jest.fn(ok);
    const handler = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream });
    expect((await call(handler, path)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
    expect(buildUpstreamUrl(path, KEY)).toBeNull();
  });

  test.each([
    '/api/eod/AAPL.US', '/api/real-time/AAPL.US', '/api/search/AAPL',
    '/api/screener', '/api/news', '/api/sentiments', '/api/calendar/earnings',
    '/api/div/AAPL.US', '/api/economic-events', '/api/exchange-details/US',
    '/api/macro-indicator/USA', '/api/sec-filings/AAPL.US/form4',
    '/api/v1.1/fundamentals/AAPL.US', '/api/mp/unicornbay/options/contracts',
  ])('%s still goes through', async (path) => {
    const upstream = jest.fn(ok);
    const handler = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream });
    expect((await call(handler, path)).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe('an upstream that stops answering', () => {
  test('the request is given a deadline rather than hanging for ever', () => {
    // There was no timeout on the upstream request and no AbortController on
    // the page: a socket that was accepted and then went quiet left the app
    // on "Loading…" indefinitely.
    // Run, not read: proxy-timeout.test.js stands a slow server up and
    // watches the request be given up on. Here, that every path has a
    // deadline at all.
    const { upstreamTimeoutMs } = require('../server/proxy.js');
    for (const p of ['/api/eod/AAPL.US', '/api/news', '/api/mp/unicornbay/spglobal/list', '/api/', '']) {
      expect(upstreamTimeoutMs(p)).toBeGreaterThan(0);
      expect(upstreamTimeoutMs(p)).toBeLessThanOrEqual(60000);
    }
  });
});

describe('a path outside /api/', () => {
  test('is a 404 from the handler, and upstream is never asked', async () => {
    const upstream = jest.fn(ok);
    const handler = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream });
    const res = await call(handler, '/api/../../evil');
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('response headers', () => {
  test('every answer says nosniff, no referrer, no framing', async () => {
    const handler = createHandler({ key: KEY, root: __dirname, fetchUpstream: ok });
    for (const url of ['/api/_status', '/api/eod/AAPL.US', '/nope']) {
      const res = await call(handler, url);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });

  test('the page carries a content-security-policy that allows what it loads', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-csp-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>x</title>');
    const handler = createHandler({ key: KEY, root, fetchUpstream: ok });
    const res = await call(handler, '/');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self' https://unpkg.com");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    // API answers are not documents. They get a policy that forbids them from
    // ever acting as one: an eodhd.com error page opened directly used to run
    // its scripts on this origin.
    expect((await call(handler, '/api/eod/AAPL.US')).headers['content-security-policy']).toMatch(/default-src 'none'; sandbox/);
  });
});

describe('.env parsing', () => {
  test('a trailing comment does not become part of the key', () => {
    expect(parseEnv('EODHD_API_KEY=68a1f0c9deadbeefcafe # my test key\n').EODHD_API_KEY).toBe('68a1f0c9deadbeefcafe');
  });

  test('export KEY=value is read', () => {
    expect(parseEnv('export EODHD_API_KEY=68a1f0c9deadbeefcafe\n').EODHD_API_KEY).toBe('68a1f0c9deadbeefcafe');
  });

  test('a hash inside quotes is kept', () => {
    expect(parseEnv('OPENAI_API_KEY="sk-abc#def0123456789"\n').OPENAI_API_KEY).toBe('sk-abc#def0123456789');
  });
});

describe('a key too short to be one', () => {
  test('is not used to scrub market data', () => {
    // scrub('Nikkei 225', ['k']) gave "Ni[redacted][redacted]ei 225".
    expect(scrub('Nikkei 225', ['k'])).toBe('Nikkei 225');
    expect(scrub('key ' + KEY + ' here', [KEY])).toBe('key [redacted] here');
  });

  test('is reported to the page as ignored, with the reason', async () => {
    const handler = createHandler({ key: '', ignoredKey: 'abc', root: __dirname, fetchUpstream: jest.fn() });
    const body = JSON.parse((await call(handler, '/api/_status')).body);
    expect(body.hasKey).toBe(false);
    expect(body.ignoredKey).toBe('abc');
    expect(body.ignoredWhy).toBe('short');
  });

  test('a placeholder still says placeholder', async () => {
    const handler = createHandler({ key: '', ignoredKey: 'demo', root: __dirname, fetchUpstream: jest.fn() });
    expect(JSON.parse((await call(handler, '/api/_status')).body).ignoredWhy).toBe('placeholder');
  });

  test('a real key never travels in that field', async () => {
    const handler = createHandler({ key: '', ignoredKey: KEY, root: __dirname, fetchUpstream: jest.fn() });
    const res = await call(handler, '/api/_status');
    expect(res.body).not.toContain(KEY);
  });
});

describe('key-shaped redaction (m8, m17)', () => {
  test('ordinary hyphenated words survive', () => {
    expect(redactKeyish('see the api-documentation for key-features')).toBe('see the api-documentation for key-features');
  });

  test('long hyphenated prose survives too', () => {
    // A long tail alone is not a key: prose has no digits and no asterisks.
    const prose = 'an api-versioning-strategy and a key-management-rotation policy';
    expect(redactKeyish(prose)).toBe(prose);
  });

  test('a real-looking key does not', () => {
    expect(redactKeyish('sk-abcdefghijklmnopqrstuvwxyz012345 leaked')).toBe('[redacted] leaked');
  });

  test('runs over the provider answer, not only its error', async () => {
    const answer = async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ choices: [{ message: { content: 'Your key is sk-abcdefghijklmnopqrstuvwxyz012345, keep it safe.' } }] }),
    });
    const handler = createHandler({ key: KEY, aiKey: 'sk-live-000000000000000000', root: __dirname, fetchUpstream: jest.fn(), fetchAI: answer });
    const chunks = [];
    const res = await new Promise((resolve) => {
      const req = { url: '/api/_ai/chat', method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, on(ev, fn) { if (ev === 'data') fn('{"messages":[]}'); if (ev === 'end') fn(); } };
      handler(req, {
        statusCode: null, headers: {},
        writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}); },
        setHeader() {},
        end(b) { if (b) chunks.push(b); resolve({ status: this.statusCode, body: chunks.join('') }); },
        write(c) { chunks.push(c); },
      });
    });
    expect(res.body).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(res.body).toContain('keep it safe');
  });
});
