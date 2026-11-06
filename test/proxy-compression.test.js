/**
 * @jest-environment node
 *
 * The static files and the API route were served without
 * compression or caching. The portfolio tracker's build/app.js went out as
 * 1,054,254 bytes on every visit, with no Cache-Control, ETag or
 * Last-Modified, and the calendar's first load was 13 MB of plain JSON.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHandler, acceptedEncodings, pickEncoding, cacheControlFor } = require('../server/proxy.js');

const KEY = '68a1f0c9deadbeefcafe';

function call(handler, url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: null,
      headers: {},
      writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}); },
      setHeader(k, v) { this.headers[k] = v; },
      write(c) { chunks.push(Buffer.from(c)); },
      end(body) {
        if (body != null) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
        resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks) });
      },
    };
    handler({ url, method, headers: Object.assign({ host: 'localhost:5173' }, headers) }, res);
  });
}
const decode = (r) => {
  const enc = r.headers['content-encoding'];
  if (enc === 'br') return zlib.brotliDecompressSync(r.body).toString('utf8');
  if (enc === 'gzip') return zlib.gunzipSync(r.body).toString('utf8');
  return r.body.toString('utf8');
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w3b-proxy-'));
const BUNDLE = '/* app */\n' + 'console.log("a line of the bundle");\n'.repeat(400);
fs.mkdirSync(path.join(root, 'build'));
fs.mkdirSync(path.join(root, 'docs'));
fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>x</title>' + '<p>text</p>'.repeat(200));
fs.writeFileSync(path.join(root, 'build', 'app.js'), BUNDLE);
fs.writeFileSync(path.join(root, 'docs', 'screenshot.png'), Buffer.alloc(4000, 7));

const BIG_JSON = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ code: 'AAA' + i, date: '2026-10-27', close: i })));
const upstream = (body, status, type, extra) => jest.fn(() => Promise.resolve({
  status: status || 200,
  headers: Object.assign({ 'content-type': type || 'application/json' }, extra || {}),
  body,
}));

describe('reading Accept-Encoding', () => {
  test.each([
    ['gzip, deflate, br', 'br'],
    ['gzip', 'gzip'],
    ['br;q=0, gzip', 'gzip'],
    ['br;q=0, gzip;q=0', null],
    ['identity', null],
    ['', null],
    ['*', 'br'],
    ['*;q=0', null],
    ['GZIP', 'gzip'],
  ])('%j -> %s', (header, want) => {
    expect(pickEncoding({ headers: { 'accept-encoding': header } })).toBe(want);
  });
  test('q values are read', () => {
    expect(acceptedEncodings('br;q=0.5, gzip;q=1')).toEqual({ br: 0.5, gzip: 1 });
  });
});

describe('static files', () => {
  const handler = createHandler({ key: KEY, root, fetchUpstream: jest.fn() });

  test('build/app.js: Brotli when accepted, gzip otherwise, as it is when neither', async () => {
    const br = await call(handler, '/build/app.js', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toBe('Accept-Encoding');
    expect(br.body.length).toBeLessThan(BUNDLE.length / 5);
    expect(decode(br)).toBe(BUNDLE);
    const gz = await call(handler, '/build/app.js', { headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(decode(gz)).toBe(BUNDLE);
    const plain = await call(handler, '/build/app.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString('utf8')).toBe(BUNDLE);
    expect(plain.headers['content-length']).toBe(String(Buffer.byteLength(BUNDLE)));
  });

  test('ETag and Last-Modified on every file; index.html and build/app.js are asked for again (no-cache)', async () => {
    for (const url of ['/', '/index.html', '/build/app.js']) {
      const r = await call(handler, url, { headers: { 'accept-encoding': 'gzip' } });
      expect(r.headers['cache-control']).toBe('no-cache');
      expect(r.headers.etag).toMatch(/^"[A-Za-z0-9_-]+-gz"$/);
      expect(new Date(r.headers['last-modified']).getTime()).toBeGreaterThan(0);
    }
    const img = await call(handler, '/docs/screenshot.png', { headers: { 'accept-encoding': 'gzip, br' } });
    expect(img.headers['cache-control']).toBe('public, max-age=86400');
    expect(img.headers['content-encoding']).toBeUndefined();
    expect(img.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });

  test('a repeat visit is a 304 with no body: by ETag of the same representation, and by date', async () => {
    const first = await call(handler, '/build/app.js', { headers: { 'accept-encoding': 'br' } });
    const again = await call(handler, '/build/app.js', { headers: { 'accept-encoding': 'br', 'if-none-match': first.headers.etag } });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    expect(again.headers.etag).toBe(first.headers.etag);
    expect(again.headers['cache-control']).toBe('no-cache');
    const weak = await call(handler, '/build/app.js', { headers: { 'accept-encoding': 'br', 'if-none-match': 'W/' + first.headers.etag } });
    expect(weak.status).toBe(304);
    // The Brotli copy's tag does not stand for the gzip or the plain one:
    // those are sent.
    const gz = await call(handler, '/build/app.js', { headers: { 'accept-encoding': 'gzip', 'if-none-match': first.headers.etag } });
    expect(gz.status).toBe(200);
    expect(gz.headers['content-encoding']).toBe('gzip');
    const plain = await call(handler, '/build/app.js', { headers: { 'if-none-match': first.headers.etag } });
    expect(plain.status).toBe(200);
    expect(plain.body.toString('utf8')).toBe(BUNDLE);
    const byDate = await call(handler, '/build/app.js', { headers: { 'if-modified-since': first.headers['last-modified'] } });
    expect(byDate.status).toBe(304);
    const stale = await call(handler, '/build/app.js', { headers: { 'if-none-match': '"nope"' } });
    expect(stale.status).toBe(200);
  });

  test('a rebuilt file has a new ETag and is sent again', async () => {
    const before = await call(handler, '/build/app.js');
    fs.writeFileSync(path.join(root, 'build', 'app.js'), BUNDLE + '// rebuilt\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, 'build', 'app.js'), future, future);
    const after = await call(handler, '/build/app.js', { headers: { 'if-none-match': before.headers.etag } });
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(before.headers.etag);
    fs.writeFileSync(path.join(root, 'build', 'app.js'), BUNDLE);
  });

  test('HEAD: the headers, no body', async () => {
    const r = await call(handler, '/build/app.js', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
    expect(r.headers['content-encoding']).toBe('gzip');
  });

  test('the allowlist still holds: .env, server/ and a traversal are 404, compressed or not', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'EODHD_API_KEY=' + KEY);
    for (const url of ['/.env', '/server/proxy.js', '/../etc/passwd', '/build/../.env']) {
      const r = await call(handler, url, { headers: { 'accept-encoding': 'gzip, br' } });
      expect(r.status).toBe(404);
      expect(r.body.toString('utf8')).not.toContain(KEY);
    }
  });

  test('a hashed file name would be kept a year; ours keep their names and are not', () => {
    expect(cacheControlFor('build/app-1a2b3c4d5e.js')).toMatch(/immutable/);
    expect(cacheControlFor('build/app.js')).toBe('no-cache');
    expect(cacheControlFor('index.html')).toBe('no-cache');
  });
});

describe('the API route', () => {
  test('a large JSON answer is compressed when the browser takes it, with Vary', async () => {
    const handler = createHandler({ key: KEY, root, fetchUpstream: upstream(BIG_JSON) });
    const r = await call(handler, '/api/calendar/earnings?from=2026-10-27', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('br');
    expect(r.headers.vary).toBe('Accept-Encoding');
    expect(JSON.parse(decode(r))).toHaveLength(300);
    expect(r.body.length).toBeLessThan(BIG_JSON.length / 3);
  });

  test('not compressed: no Accept-Encoding, a small answer, a 403 body (the sentence stays readable either way)', async () => {
    let handler = createHandler({ key: KEY, root, fetchUpstream: upstream(BIG_JSON) });
    let r = await call(handler, '/api/eod/AAPL.US');
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.body.toString('utf8')).toBe(BIG_JSON);
    handler = createHandler({ key: KEY, root, fetchUpstream: upstream('[]') });
    r = await call(handler, '/api/eod/AAPL.US', { headers: { 'accept-encoding': 'gzip' } });
    expect(r.headers['content-encoding']).toBeUndefined();
    handler = createHandler({ key: KEY, root, fetchUpstream: upstream('Forbidden. You have no access to this data feed.', 403, 'text/plain') });
    r = await call(handler, '/api/news?s=AAPL.US', { headers: { 'accept-encoding': 'gzip' } });
    expect(r.status).toBe(403);
    expect(decode(r)).toBe('Forbidden. You have no access to this data feed.');
  });

  test('the key is scrubbed before compression: it never reaches the browser, packed or not', async () => {
    const leaky = JSON.stringify({ url: 'https://eodhd.com/api/eod/AAPL.US?api_token=' + KEY, rows: JSON.parse(BIG_JSON) });
    const handler = createHandler({ key: KEY, root, fetchUpstream: upstream(leaky) });
    for (const enc of ['br', 'gzip', '']) {
      const r = await call(handler, '/api/eod/AAPL.US', { headers: enc ? { 'accept-encoding': enc } : {} });
      expect(decode(r)).not.toContain(KEY);
    }
  });

  test('a 429 passes its Retry-After on, so the page waits that long', async () => {
    const handler = createHandler({ key: KEY, root, fetchUpstream: upstream('{"message":"Too Many Requests"}', 429, 'application/json', { 'retry-after': '30' }) });
    const r = await call(handler, '/api/real-time/AAPL.US');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('30');
  });
});
