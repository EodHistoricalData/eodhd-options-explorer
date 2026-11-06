// Options deep link — the contract the EODHD Academy links into:
//   #/options?symbol=AAPL.US
//
// The options explorer already opened a chain from the hash, but in the form
// `#AAPL.US` — a bare symbol with no route. That worked only while the explorer was
// already on screen: on a reload the app router read `AAPL.US`, found no such tab,
// and showed the dashboard, so the link the explorer wrote for "share this chain"
// never survived being shared. This module gives the chain an address the router
// understands, and keeps reading the old form so nothing that worked stops working.
//
// Pure, no React, mirrors screenerDeepLink.js: app.js already routes `#/options`
// with the query ignored (`.split('?')[0]`), so the explorer consumes the symbol on
// mount. The symbol stays in the URL after consumption on purpose — unlike the
// screener, where re-running a search on Back is a cost, here the URL *is* the
// feature: reload and you are on the same chain.
(function () {
  // A symbol starts with a letter or digit and does not end on, or double, a
  // separator: ".." and "-" passed and cost six requests each, or read ".. is
  // listed outside the US".
  // A leading "^" is the index mark (^GSPC, ^NDX): the link is read, and the
  // page says index options are not offered, where it opened the landing page
  // with no word.
  const SYMBOL = /^\^?(?!.*\.\.)[A-Z0-9](?:[A-Z0-9.\-]{0,18}[A-Z0-9])?$/i;

  function splitHash(hash) {
    const raw = String(hash || '').replace(/^#\/?/, '');
    const q = raw.indexOf('?');
    return q === -1 ? { tab: raw, query: '' } : { tab: raw.slice(0, q), query: raw.slice(q + 1) };
  }

  // The chain a hash names, or null. Two shapes: `#/options?symbol=X`, and the legacy
  // bare `#X` the explorer used to write, which only ever meant an options symbol.
  // The explorer's tools. The open one rides in the link too: a reload or a
  // shared GEX link landed back on the chain.
  const TOOLS = ['chain', 'calculator', 'gex', 'payoff', 'unusual', 'iv', 'advisor'];

  function parse(hash) {
    const { tab, query } = splitHash(hash);
    let symbol = null;
    let tool = null;
    if (tab === 'options') {
      let params;
      try { params = new URLSearchParams(query); } catch (_) { return null; }
      symbol = params.get('symbol');
      const t = String(params.get('tab') || '').toLowerCase();
      if (TOOLS.indexOf(t) > 0) tool = t;
    } else if (tab && !query && tab.indexOf('/') === -1 && !/^#?\//.test(String(hash || ''))) {
      // Only the shape the explorer wrote: "#AAPL.US", no slash, with its
      // exchange. "#/calculator", "#/payoff" and a skip link's "#main"
      // selected the tickers CALCULATOR, PAYOFF and MAIN -- on arrival and,
      // since 23.10, on a hashchange inside the open page. A route word is never a symbol.
      let bare = tab;
      try { bare = decodeURIComponent(tab); } catch (_) { return null; }
      // Any exchange, one letter too: "#ABC.V" (TSX Venture) and "#SAP.F"
      // (Frankfurt) stopped opening when two letters were required. A share class ("#BRK.B") opens as before.
      if (!/\.[A-Z]+$/i.test(bare.trim())) return null;
      symbol = bare;
    }
    if (!symbol) return null;
    const s = String(symbol).trim().toUpperCase();
    if (!SYMBOL.test(s)) return null;
    return tool ? { symbol: s, tab: tool } : { symbol: s };
  }

  // The routable address for a chain: what the explorer writes when a ticker is
  // picked, and when a tool other than the chain is open.
  function linkFor(symbol, tool) {
    const t = String(tool || '').toLowerCase();
    return '#/options?symbol=' + encodeURIComponent(String(symbol || '').toUpperCase())
      + (TOOLS.indexOf(t) > 0 ? '&tab=' + t : '');
  }

  // Read the link on mount and normalise the URL to the routable form, so a link that
  // arrived in the legacy shape leaves in the shape a reload can follow.
  function consume() {
    if (typeof window === 'undefined') return null;
    const link = parse(window.location.hash);
    if (!link) return null;
    try { window.history.replaceState(null, '', linkFor(link.symbol, link.tab)); } catch (_) {}
    return link;
  }

  // The options feed (UnicornBay, via EODHD) lists US underlyings only, and it is
  // keyed by the bare ticker. Sending SHEL.LSE as "SHEL" came back with the NYSE
  // ADR's chain (USD, strikes 50-115) priced against the London quote in pence
  // (3594), so every call read in the money and GEX was fifty times too large --
  // and a trial account spent one of its three daily chains on it. Only a US
  // listing may ask. Which listing a code names is the shared reader's call
  // (window.SymbolCode): a bare code is not always American -- BTC-USD is a
  // crypto pair on CC and EURUSD / XAUUSD are FOREX pairs, and a link to them
  // sent real-time, end-of-day and four options requests before reading "no
  // options". The venues the search hands back
  // (AAPL.NASDAQ) are .US, BRK.B is a share class, ABC.V and SAP.F are not
  // American.
  function isUSListed(symbol) {
    const SC = window.SymbolCode;
    const read = SC ? SC.of(symbol) : null;
    return !!read && /\.US$/.test(read);
  }

  // Funds that track the indices people link to, as the portfolio says it.
  const INDEX_FUNDS = { GSPC: 'SPY.US', SPX: 'SPY.US', NDX: 'QQQ.US', DJI: 'DIA.US', RUT: 'IWM.US', IXIC: 'ONEQ.US' };

  // Why no chain is asked for this code, or null for a US listing. Each kind
  // in its own words: GSPC.INDX read "listed outside the US", though the
  // S&P 500 is an American index.
  function whyNot(symbol) {
    const SC = window.SymbolCode;
    const raw = String(symbol || '').trim();
    const head = 'Options are available for US-listed underlyings. ';
    if (SC && SC.index && /^\^|\.INDX$/i.test(raw)) {
      const ix = SC.index(raw);
      if (ix.code) {
        const fund = INDEX_FUNDS[ix.code.replace(/\.INDX$/, '')];
        // No fund named for an index we have none for: SPY or QQQ do not
        // track the FTSE.
        return 'Options on an index are not offered here: ' + ix.code + ' is an index. '
          + (fund ? 'Use a fund that tracks it, e.g. ' + fund + '.' : 'Use a fund that tracks it instead.');
      }
    }
    const read = SC ? SC.of(raw) : null;
    if (!read) return '"' + raw.slice(0, 30) + '" is not a ticker. Use a US code, e.g. AAPL or AAPL.US.';
    if (/\.US$/.test(read)) return null;
    return head + raw.toUpperCase() + ' is listed outside the US.';
  }

  // The sentence for an options link whose symbol cannot be read at all
  // ("#/options?symbol=..", "<script>"), or null. Nothing is asked for it,
  // and the page says so instead of opening the landing page with no word.
  function linkProblem(hash) {
    const { tab, query } = splitHash(hash);
    if (tab !== 'options' || parse(hash)) return null;
    let raw;
    try { raw = new URLSearchParams(query).get('symbol'); } catch (_) { return null; }
    if (raw == null || !String(raw).trim()) return null;
    return '"' + String(raw).trim().slice(0, 30) + '" is not a ticker. Use a US code, e.g. AAPL or AAPL.US.';
  }

  // The ticker a chain belongs to. The envelope api.js builds carries `code`
  // (and `exchange`), never `symbol` -- three AI prompts read `.symbol` and sent
  // "Unknown" as the ticker in every analysis they were charged for.
  function tickerOf(optionsData) {
    if (!optionsData) return 'Unknown';
    return optionsData.code || optionsData.symbol || 'Unknown';
  }

  window.OptionsDeepLink = { splitHash, parse, linkFor, consume, isUSListed, whyNot, linkProblem, tickerOf };
})();
