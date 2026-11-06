/** The local proxy does not pass Morningstar's fields on. */
const { createHandler, isFundamentalsPath, asksForMorningstar } = require('../server/proxy.js');

const KEY = '68a1f0c9deadbeefcafe';
function call(handler, url) {
  return new Promise((resolve) => {
    const res = {
      statusCode: null, headers: {},
      writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}); },
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { resolve({ status: this.statusCode, body: body || '' }); },
      write() {},
    };
    handler({ url, method: 'GET', headers: { host: 'localhost:5173' } }, res);
  });
}
const VOO = { General: { Type: 'ETF', Name: 'Vanguard S&P 500 ETF', Category: 'Large Blend' },
  ETF_Data: { Yield: '1.06', MorningStar: { Ratio: '4', Category_Benchmark: 'S&P 500 TR USD' }, Holdings: { 'AAPL.US': {} } } };

test('fundamentals lose MorningStar and the category name; other fields stay', async () => {
  const upstream = jest.fn(async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(VOO) }));
  const h = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream });
  const r = await call(h, '/api/v1.1/fundamentals/VOO.US');
  const d = JSON.parse(r.body);
  expect(d.ETF_Data.MorningStar).toBeUndefined();
  expect(d.General.Category).toBeUndefined();
  expect(d.ETF_Data.Yield).toBe('1.06');
  expect(d.ETF_Data.Holdings).toEqual(VOO.ETF_Data.Holdings);
});

test('a filter naming a Morningstar field is answered NA without asking upstream', async () => {
  const upstream = jest.fn();
  const h = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream });
  for (const f of ['ETF_Data::MorningStar', 'MutualFund_Data::Morning_Star_Rating', 'General::Category']) {
    const r = await call(h, '/api/v1.1/fundamentals/VOO.US?filter=' + encodeURIComponent(f));
    expect(r.body).toBe('"NA"');
  }
  expect(upstream).not.toHaveBeenCalled();
});

test('other feeds pass through untouched; path detection survives versions', async () => {
  const body = JSON.stringify([{ MorningStar: 1 }]);
  const upstream = jest.fn(async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body }));
  const h = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream });
  expect((await call(h, '/api/news?s=AAPL.US')).body).toBe(body);
  expect(isFundamentalsPath('/api/v1.1/fundamentals/VOO.US')).toBe(true);
  expect(isFundamentalsPath('/api/bulk-fundamentals/US')).toBe(true);
  expect(isFundamentalsPath('/api/eod/VOO.US')).toBe(false);
  expect(asksForMorningstar('ETF_Data::Holdings')).toBe(false);
});

test('a mixed filter keeps its other fields and loses only the Morningstar ones', async () => {
  let asked = null;
  const upstream = jest.fn(async (url) => { asked = url; return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"General::Name":"Vanguard S&P 500 ETF"}' }; });
  const h = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream });
  const r = await call(h, '/api/v1.1/fundamentals/VOO.US?filter=' + encodeURIComponent('General::Name,ETF_Data::MorningStar'));
  expect(asked.searchParams.get('filter')).toBe('General::Name');
  expect(JSON.parse(r.body)).toEqual({ 'General::Name': 'Vanguard S&P 500 ETF' });
});

test('the proxy drops Relative_to_Category and refuses a filter naming it', async () => {
  const body = JSON.stringify({ ETF_Data: { Sector_Weights: { Technology: { 'Equity_%': '31', Relative_to_Category: '27' } } } });
  const upstream = jest.fn(async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body }));
  const h = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream });
  const r = await call(h, '/api/v1.1/fundamentals/VOO.US');
  expect(JSON.parse(r.body)).toEqual({ ETF_Data: { Sector_Weights: { Technology: { 'Equity_%': '31' } } } });
  expect(asksForMorningstar('ETF_Data::Sector_Weights::Technology::Relative_to_Category')).toBe(true);
});

test('Valuations_Growth loses its comparisons with the category and keeps the fund\'s own figures', async () => {
  const growth = {
    Valuations_Rates_Portfolio: { 'Price/Prospective Earnings': '21.5', 'Price/Book': '4.2' },
    Valuations_Rates_To_Category: { 'Price/Prospective Earnings': '19.8', 'Price/Book': '3.9' },
    Growth_Rates_Portfolio: { 'Long-Term Projected Earnings Growth': '11.2' },
    Growth_Rates_To_Category: { 'Long-Term Projected Earnings Growth': '10.4' },
  };
  const own = { Valuations_Rates_Portfolio: growth.Valuations_Rates_Portfolio, Growth_Rates_Portfolio: growth.Growth_Rates_Portfolio };
  let body = JSON.stringify({ General: { Type: 'ETF' }, ETF_Data: { Yield: '1.06', Valuations_Growth: growth } });
  const upstream = jest.fn(async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body }));
  const h = createHandler({ key: KEY, root: __dirname, fetchUpstream: upstream });

  // The whole document.
  expect(JSON.parse((await call(h, '/api/v1.1/fundamentals/VOO.US')).body))
    .toEqual({ General: { Type: 'ETF' }, ETF_Data: { Yield: '1.06', Valuations_Growth: own } });

  // The section asked for by name: upstream answers it bare, and it is cleaned the same.
  body = JSON.stringify(growth);
  expect(JSON.parse((await call(h, '/api/v1.1/fundamentals/VOO.US?filter=' + encodeURIComponent('ETF_Data::Valuations_Growth'))).body))
    .toEqual(own);
  expect(upstream).toHaveBeenCalledTimes(2);

  // A filter that names only the comparisons is answered NA without asking.
  for (const f of ['ETF_Data::Valuations_Growth::Valuations_Rates_To_Category',
    'ETF_Data::Valuations_Growth::Growth_Rates_To_Category',
    'ETF_Data::Valuations_Growth::Valuations_Rates_To_Category,ETF_Data::Valuations_Growth::Growth_Rates_To_Category']) {
    expect((await call(h, '/api/v1.1/fundamentals/VOO.US?filter=' + encodeURIComponent(f))).body).toBe('"NA"');
  }
  expect(upstream).toHaveBeenCalledTimes(2);

  // Mixed with the fund's own figures, only those go upstream.
  let asked = null;
  upstream.mockImplementationOnce(async (url) => { asked = url; return { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }; });
  await call(h, '/api/v1.1/fundamentals/VOO.US?filter=' + encodeURIComponent('ETF_Data::Valuations_Growth::Growth_Rates_Portfolio,ETF_Data::Valuations_Growth::Growth_Rates_To_Category'));
  expect(asked.searchParams.get('filter')).toBe('ETF_Data::Valuations_Growth::Growth_Rates_Portfolio');
  expect(asksForMorningstar('ETF_Data::Valuations_Growth::Valuations_Rates_Portfolio')).toBe(false);
});
