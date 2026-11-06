/**
 * @jest-environment node
 *
 * The proxy's side of a slow feed: the news feed answers in 14 to 22
 * seconds for one symbol, and the proxy hung up at 20 with a 502.
 */
const http = require('node:http');
const { fetchUpstream, upstreamTimeoutMs, createHandler } = require('../server/proxy.js');

const KEY = '68a1f0c9deadbeefcafe';

/** A local server that answers `body` after `delayMs`. */
function slowServer(delayMs, body) {
  return new Promise((resolve) => {
    const timers = [];
    const server = http.createServer((req, res) => {
      timers.push(setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      }, delayMs));
    });
    server.on('close', () => timers.forEach(clearTimeout));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const close = (server) => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); });

test('news is allowed 45 seconds; every other feed keeps 20', () => {
  expect(upstreamTimeoutMs('/api/news')).toBe(45000);
  for (const p of ['/api/real-time/AAPL.US', '/api/eod/AAPL.US', '/api/sentiments', '/api/screener',
    '/api/mp/unicornbay/options/contracts', '/api/v1.1/fundamentals/VOO.US', '/api/calendar/earnings',
    // Not the feed, only its name somewhere else in the path.
    '/api/search/news', '/api/eod/news']) {
    expect(upstreamTimeoutMs(p)).toBe(20000);
  }
});

test('an upstream slower than the deadline is given up on, with the deadline named', async () => {
  const server = await slowServer(400, '[]');
  const url = new URL('http://127.0.0.1:' + server.address().port + '/api/eod/AAPL.US');
  await expect(fetchUpstream(url, null, { timeoutMs: 100 })).rejects.toThrow('did not answer within 0.1 seconds');
  await close(server);
});

test('an upstream inside the deadline is answered whole', async () => {
  const server = await slowServer(150, '[{"title":"late but here"}]');
  const base = 'http://127.0.0.1:' + server.address().port;
  // The path decides: this one waits its 45 seconds, far past 150 ms.
  const answer = await fetchUpstream(new URL(base + '/api/news?s=AAPL.US'));
  expect(answer.status).toBe(200);
  expect(JSON.parse(answer.body)).toEqual([{ title: 'late but here' }]);
  await close(server);
});

test('the handler hands the request path to the upstream call, and a timeout is a 502 with the reason', async () => {
  const seen = [];
  const handler = createHandler({
    key: KEY, root: __dirname,
    fetchUpstream: async (url) => {
      seen.push(url.pathname);
      throw new Error('eodhd.com did not answer within ' + (upstreamTimeoutMs(url.pathname) / 1000) + ' seconds');
    },
  });
  const ask = (url) => new Promise((resolve) => {
    handler({ url, method: 'GET', headers: { host: 'localhost:5173' } }, {
      writeHead(code) { this.code = code; }, setHeader() {}, write() {},
      end(body) { resolve({ status: this.code, body: String(body || '') }); },
    });
  });
  const news = await ask('/api/news?s=AAPL.US&limit=5');
  expect(news.status).toBe(502);
  expect(news.body).toContain('within 45 seconds');
  expect((await ask('/api/eod/AAPL.US')).body).toContain('within 20 seconds');
  expect(seen).toEqual(['/api/news', '/api/eod/AAPL.US']);
});
