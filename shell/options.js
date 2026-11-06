/**
 * The options chain.
 *
 * Kept out of shell/api.js and copied only into the app that asks for it.
 * That file says of itself that only the endpoints the modules reach for
 * belong in it, because a sample app should be readable in a sitting -- and
 * this adapter is a hundred and forty lines of pagination, field mapping and
 * unit correction that six of the seven apps never call. Shipping it into the
 * screener, which makes exactly one request in its life, would have made that
 * sentence untrue.
 *
 * Loads after shell/api.js and adds one method to the client it defines.
 *
 * The feed is mp/unicornbay/options/contracts, not /api/options/{symbol}. The
 * latter reports the previous session's numbers under the current session's
 * date: on AAPL 2026-08-31 C320, both labelled 2026-08-28, it had last 0.80
 * and open interest 2053 where this feed had 1.40 and 4387 -- its "last" is
 * this feed's "previous".
 *
 * The rows are adapted back into the envelope the vendored view has always
 * read, so that module is untouched:
 *
 *   { code, exchange, lastTradeDate,
 *     data: [ { expirationDate, options: { CALL: [...], PUT: [...] } } ] }
 */
(function () {
  var API = window.EODHD_API;
  if (!API) return;

  var OPTIONS_PAGE_SIZE = 1000;   // the endpoint's ceiling; 2000 answers 422
  var OPTIONS_PAGES = 4;          // AAPL's whole live chain is exactly four

  var US_SUFFIX = /\.(US|NYSE|NASDAQ|AMEX|BATS|ARCA|CBOE)$/;

  /**
   * The ticker as the options feed spells it.
   *
   * Everything reaching this file is US-listed -- the view refuses the rest --
   * so a venue suffix goes, and what is left is the ticker. A one-letter tail
   * is a share class, not an exchange (the view's own rule, in
   * optionsDeepLink.js), and EODHD writes the class with a dash: BRK.B is
   * BRK-B. Cutting at the first dot asked the feed for "BRK", which has no
   * options, so `#/options?symbol=BRK.B` said there were none.
   */
  function usUnderlying(symbol) {
    var s = String(symbol || '').trim().toUpperCase().replace(US_SUFFIX, '');
    var cls = s.match(/^([A-Z0-9]+)\.([A-Z])$/);
    if (cls) return cls[1] + '-' + cls[2];
    return s.split('.')[0];
  }
  API._usUnderlying = usUnderlying;

  // The quote and the end-of-day fallback the view asks for next to the
  // chain, for the same reason: real-time/BRK.B is read as exchange "B" and
  // answers nothing. Only in this app -- elsewhere a one-letter suffix can be
  // a real exchange (F is Frankfurt).
  ['getRealTimeData', 'getHistoricalData'].forEach(function (name) {
    var original = API[name];
    if (typeof original !== 'function') return;
    API[name] = function (k, symbol) {
      var args = Array.prototype.slice.call(arguments);
      var s = String(symbol || '').trim().toUpperCase();
      if (/^[A-Z0-9]+\.[A-Z](\.US)?$/.test(s)) args[1] = usUnderlying(s) + '.US';
      return original.apply(API, args);
    };
  });

  /** One marketplace row -> one contract in the shape the view reads. */
  function optionContract(a) {
    // "NA" is how EODHD writes an empty number, and Number("NA") is NaN:
    // the chain printed whole rows of "NaN". Anything not finite is no value.
    function num(v) {
      if (v == null || v === '') return null;
      var n = Number(v);
      return isFinite(n) ? n : null;
    }
    var iv = num(a.volatility);
    return {
      contractName: a.contract,
      contractSize: 'REGULAR',
      contractPeriod: a.expiration_type || null,
      currency: a.currency || 'USD',
      type: String(a.type || '').toUpperCase(),
      // A signed fraction upstream: positive is in the money. Kept as the
      // 'TRUE'/'FALSE' strings the field has always held.
      inTheMoney: num(a.moneyness) > 0 ? 'TRUE' : 'FALSE',
      lastTradeDateTime: a.tradetime || null,
      expirationDate: a.exp_date,
      strike: num(a.strike),
      // The feed sends last: 0 for a contract that has not traded, and the
      // chain showed "0.00" beside a 46.75 bid as if it were a trade. A price
      // of zero is no price (the payoff builder already reads it that way).
      lastPrice: num(a.last) > 0 ? num(a.last) : null,
      bid: num(a.bid),
      ask: num(a.ask),
      change: num(a.change),
      changePercent: num(a.pctchange),
      volume: num(a.volume),
      openInterest: num(a.open_interest),
      // Left as the fraction upstream sends, which is what the chain table
      // reads: it renders `impliedVolatility * 100` with a % sign.
      //
      // The legacy endpoint sent a percentage — 19.79 for the same contract —
      // so that table printed 1979.0%. Everything else that touches IV guards
      // with `iv > 5 ? iv / 100 : iv` and coped with either, which is why it
      // went unnoticed.
      impliedVolatility: iv,
      delta: num(a.delta),
      gamma: num(a.gamma),
      theta: num(a.theta),
      vega: num(a.vega),
      rho: num(a.rho),
      theoretical: num(a.theoretical),
      updatedAt: a.tradetime || null,
      daysBeforeExpiration: num(a.dte),
      bidSize: num(a.bid_size),
      askSize: num(a.ask_size),
      midpoint: num(a.midpoint),
    };
  }

  /** Rows -> the envelope, grouped by expiry with calls and puts split. */
  function optionsEnvelope(symbol, rows) {
    var byExpiry = {};
    var order = [];
    var latest = null;
    var seen = {};

    rows.forEach(function (row) {
      var a = (row && row.attributes) || row;
      if (!a || !a.exp_date) return;
      // Pages are fetched together rather than in sequence, so a contract
      // arriving twice means two pages overlapped. Counting it twice would
      // double an open-interest total silently.
      var id = a.contract || (a.exp_date + a.type + a.strike);
      if (seen[id]) return;
      seen[id] = true;
      if (a.tradetime && (!latest || a.tradetime > latest)) latest = a.tradetime;
      if (!byExpiry[a.exp_date]) {
        byExpiry[a.exp_date] = { expirationDate: a.exp_date, options: { CALL: [], PUT: [] } };
        order.push(a.exp_date);
      }
      var contract = optionContract(a);
      var side = byExpiry[a.exp_date].options[contract.type];
      if (side) side.push(contract);
    });

    // Nearest first: the view opens on data[0].
    order.sort();
    var data = order.map(function (date) {
      var expiry = byExpiry[date];
      expiry.options.CALL.sort(function (x, y) { return x.strike - y.strike; });
      expiry.options.PUT.sort(function (x, y) { return x.strike - y.strike; });
      return expiry;
    });

    // Only US listings reach this file (the view refuses the rest), so the
    // exchange is US and the code is the feed's own spelling of the ticker.
    return { code: usUnderlying(symbol), exchange: 'US', lastTradeDate: latest, data: data };
  }

  /**
   * The options chain, from the marketplace feed.
   *
   * Not /api/options/{symbol}. That endpoint is a session behind: measured
   * on AAPL 2026-08-31 C320 while both sources called themselves 2026-08-28,
   * it reported last 0.80 and open interest 2053 where this feed had 1.40
   * and 4387 -- its "last" is this feed's "previous". It also carries 27
   * fields against 43.
   *
   * The rows are adapted back into the shape the view has always read, so
   * the vendored module is untouched:
   *
   *   { code, exchange, lastTradeDate,
   *     data: [ { expirationDate, options: { CALL: [...], PUT: [...] } } ] }
   *
   * Fetched as one fan of four pages rather than a walk, because a page
   * costs per-request overhead rather than payload -- one takes about five
   * seconds and four in parallel take about the same. Four covers AAPL's
   * whole live chain. It does not cover SPY, whose 12,608 live contracts
   * need thirteen; that chain comes back cut, and says so.
   */
  /**
   * One expiry, complete, in one request.
   *
   * What the feed is actually built for, and the answer for the names the fan
   * below cannot finish. SPY has 12,608 live contracts across 31 expiries --
   * thirteen pages if you ask for the chain -- but a single expiry is 316 to
   * 642 contracts and comes back in two to four seconds.
   *
   * No sort: a window narrow enough to hold one expiry fits inside a page, so
   * ordering costs a second or two and buys nothing.
   */
  API.getOptionsExpiry = function (_k, symbol, date) {
    var underlying = usUnderlying(symbol);
    return API._request(['mp', 'unicornbay', 'options', 'contracts'], {
      'filter[underlying_symbol]': underlying,
      'filter[exp_date_from]': date,
      'filter[exp_date_to]': date,
      'page[limit]': OPTIONS_PAGE_SIZE,
    }, { why: true }).then(function (body) {
      // Not served: the expiry with what failed (`notServed`), as the
      // terminal's client answers, so the view keeps what it has, says why
      // and asks again on Try again. A body that is no contract list
      // ({"message"} with 200) could not be read: it was the empty expiry
      // an answer with no contracts gives.
      var empty = { expirationDate: date, options: { CALL: [], PUT: [] } };
      if (!body || body.notServed) return Object.assign(empty, { notServed: (body && body.notServed) || {} });
      if (!Array.isArray(body.data)) return Object.assign(empty, { notServed: { status: 200, unreadable: true } });
      var envelope = optionsEnvelope(symbol, body.data);
      // An answer with no contracts: empty, not null -- the view swaps it in
      // for the entry it was rendering.
      return envelope.data[0] || { expirationDate: date, options: { CALL: [], PUT: [] } };
    });
  };

  /**
   * The expiry dates after the ones already on screen.
   *
   * Only the dates -- fields[] keeps the payload small, and the sort is what
   * makes "the next ones" mean anything. Asked for when somebody reaches the
   * end of the strip, not up front: enumerating all of SPY's thirty-one would
   * be eleven of these chained one after another.
   */
  /**
   * Expiry dates after the ones on screen.
   *
   * A page is a thousand contracts, and SPY lists so many strikes that a
   * thousand contracts is four expiries -- so "Later dates" answered with four
   * and had to be pressed seven times to reach the end. Given
   * the spot price, the query is narrowed to calls within five percent of it:
   * a handful of contracts per expiry, and the same page then spans them all.
   * Measured on SPY: 4 expiries a click without the window, 27 -- every date
   * to December 2028 -- with it. Without a price it falls back to the wide
   * query, which is still correct, only slower.
   */
  API.getMoreOptionsExpirations = function (_k, symbol, after, nearPrice) {
    var underlying = usUnderlying(symbol);
    var from = new Date(new Date(after).getTime() + 86400000).toISOString().slice(0, 10);
    var params = {
      'filter[underlying_symbol]': underlying,
      'filter[exp_date_from]': from,
      sort: 'exp_date',
      'page[limit]': OPTIONS_PAGE_SIZE,
      'fields[options-contracts]': 'exp_date',
    };
    var price = Number(nearPrice);
    if (price > 0) {
      params['filter[type]'] = 'call';
      params['filter[strike_from]'] = Math.floor(price * 0.95);
      params['filter[strike_to]'] = Math.ceil(price * 1.05);
    }
    // Not served -- no answer, a refusal, the limit, a body that is no
    // contract list -- is no dates with what failed (`failed`, not
    // enumerable), as the terminal's client answers: it read "No later
    // dates".
    var notServed = function (why) {
      var none = [];
      Object.defineProperty(none, 'failed', { value: why || {}, enumerable: false });
      return none;
    };
    return API._request(['mp', 'unicornbay', 'options', 'contracts'], params, { why: true }).then(function (body) {
      if (!body || body.notServed) return notServed(body && body.notServed);
      if (!Array.isArray(body.data)) return notServed({ status: 200, unreadable: true });
      var seen = [];
      ((body && body.data) || []).forEach(function (row) {
        var date = row && row.attributes && row.attributes.exp_date;
        if (date && seen.indexOf(date) === -1) seen.push(date);
      });
      var dates = seen.sort();
      // A page that was not full held every remaining date: the view then
      // stops offering "Later dates" instead of spending a click, and a
      // metered request, on finding out. On the list itself, where the view
      // reads it, and not enumerable -- the answer is still just the dates.
      // A request that was not served says nothing either way.
      var rows = (body && body.data) || [];
      Object.defineProperty(dates, 'complete', { value: Boolean(body) && rows.length < OPTIONS_PAGE_SIZE, enumerable: false });
      return dates;
    }).catch(function (e) { return notServed({ status: (e && e.status) || 0 }); });
  };

  API.getOptionsChain = function (_k, symbol) {
    // Once the plan has refused this feed, the symbol it refused is not asked
    // for again -- the panel is already up. The caller gets null (nothing
    // was asked), and its own message points to the panel while the refusal
    // is on screen. An empty chain is an envelope with no expiries, and a
    // chain that was not served carries `notServed` (notServedChain). Another symbol is asked for, first page first: the refusal
    // used to be kept for every symbol until a reload, so a chain that would
    // have been served -- MSFT after AAPL was refused -- read "No Options
    // Available". A served chain forgets the refusals.
    //
    // The first load costs four pages in parallel plus
    // a refetch per expiry split across pages. Every one of them is metered:
    // a Marketplace request counts 10 against the product's own allowance
    // (EODHD's API-limits table), so opening a symbol is roughly 70 units.
    // The answer is kept for a quarter of an hour, so going back to a symbol,
    // or switching to the next and back, does not pay for it again.
    var planRefused = Boolean(window.Entitlement && window.Entitlement.get('options').allowed === false);
    if (planRefused && refusedChains[usUnderlying(symbol)]) {
      return Promise.resolve(null);
    }
    // Nor when the key itself has just been turned away. The view asks for
    // the quote first and, without one, for the last close; if those came
    // back "daily limit" or "too many requests" or "unauthenticated", four
    // chain pages sent at once are four more of the same answer -- six
    // requests spent on one refused symbol. A success on any feed lifts
    // this, and the view asks for a quote before every chain. A plan refusal
    // of the quote is not a reason: real-time and the options add-on are
    // sold separately, and a key can have the second without the first.
    if (window.Entitlement && window.Entitlement.keyWide && window.Entitlement.keyWide()) {
      return Promise.resolve(null);
    }
    var underlying = usUnderlying(symbol);
    var from = new Date().toISOString().slice(0, 10);
    var cacheKey = underlying + ' ' + from;
    var hit = chainCache[cacheKey];
    if (hit && Date.now() - hit.at < CHAIN_TTL_MS) return hit.promise;
    // A reload used to pay the ~70 units again: the answer is
    // also kept in localStorage for the same quarter of an hour.
    var stored = readStoredChain(cacheKey);
    if (stored) {
      chainCache[cacheKey] = { at: stored.at, promise: Promise.resolve(stored.env) };
      return chainCache[cacheKey].promise;
    }
    var promise = loadChain(symbol, underlying, from, planRefused);
    chainCache[cacheKey] = { at: Date.now(), promise: promise };
    // A failure or an empty answer is not kept: the next try asks again.
    // An empty answer was served, though, and forgets the refusals as a
    // chain does.
    promise.then(function (env) {
      var failed = !env || Boolean(env.notServed);
      var empty = !failed && !(env.data && env.data.length);
      if (failed || empty) delete chainCache[cacheKey];
      if (failed) {
        if (window.Entitlement && window.Entitlement.get('options').allowed === false) refusedChains[underlying] = true;
      } else {
        Object.keys(refusedChains).forEach(function (k) { delete refusedChains[k]; });
        if (!empty) writeStoredChain(cacheKey, env);
      }
    }, function () { delete chainCache[cacheKey]; });
    return promise;
  };

  /**
   * A chain that was not served, told apart from one with no contracts.
   * Both were null, and the view -- which since 02.11 reads null as a
   * failure -- said "Options did not load … EODHD did not answer" for a
   * ticker EODHD had answered has no options, with a Try again that gave
   * the same for ever. `notServed` carries the
   * answer's status (or `unreadable`) for RateLimitWait.failure(), so a 500
   * is named as one; it has no `error`, which the view reads as an answer.
   */
  function notServedChain(symbol, why) {
    return Object.assign(optionsEnvelope(symbol, []), { complete: false, notServed: why || {} });
  }
  API._optionsNotServed = notServedChain;

  // localStorage copy of the chain, named by the key's tag (a hash prefix the
  // server gives at boot) so another key -- another plan -- never reads it.
  // At most CHAIN_STORE_MAX symbols; a full store simply goes without.
  var CHAIN_STORE_PREFIX = 'eodhd_oss_chain:';
  var CHAIN_STORE_MAX = 6;
  function storeName(cacheKey) {
    return CHAIN_STORE_PREFIX + (window.EODHD_KEY_TAG || 'nokey') + ':' + cacheKey;
  }
  function readStoredChain(cacheKey) {
    try {
      if (!window.EODHD_KEY_TAG) return null;
      var raw = window.localStorage.getItem(storeName(cacheKey));
      if (!raw) return null;
      var rec = JSON.parse(raw);
      if (!rec || !rec.env || typeof rec.at !== 'number' || Date.now() - rec.at >= CHAIN_TTL_MS) {
        window.localStorage.removeItem(storeName(cacheKey));
        return null;
      }
      return rec;
    } catch (_) { return null; }
  }
  function writeStoredChain(cacheKey, env) {
    try {
      if (!window.EODHD_KEY_TAG) return;
      var ls = window.localStorage;
      var mine = [];
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (k && k.indexOf(CHAIN_STORE_PREFIX) === 0) {
          var at = 0;
          try { at = JSON.parse(ls.getItem(k)).at || 0; } catch (_) {}
          if (Date.now() - at >= CHAIN_TTL_MS) { ls.removeItem(k); i--; } else mine.push({ k: k, at: at });
        }
      }
      mine.sort(function (a, b) { return a.at - b.at; });
      while (mine.length >= CHAIN_STORE_MAX) ls.removeItem(mine.shift().k);
      ls.setItem(storeName(cacheKey), JSON.stringify({ at: Date.now(), env: env }));
    } catch (_) { /* quota or privacy mode: memory cache only */ }
  }

  var CHAIN_TTL_MS = 15 * 60 * 1000;
  var chainCache = {};
  // Underlyings whose chain the plan refused, until a chain is served.
  var refusedChains = {};
  API._refusedChains = refusedChains;
  /**
   * A ticker picked by hand: its refusal is forgotten, so the pick is asked
   * again (first page alone, while the plan stands refused). Without it a
   * re-pick of a refused ticker sent nothing and read "No Options Available"
   * until a reload. The terminal's view calls this when it exists.
   */
  API.forgetOptionsRefusal = function (symbol) {
    delete refusedChains[usUnderlying(symbol)];
  };
  API._optionsChainCache = chainCache;

  /**
   * `probeFirst`: ask for the first page alone, and for the rest only if it
   * was served and full. Used once the plan has refused this feed for some
   * other symbol -- one request, not four, to find out whether this one is
   * refused too. The ordinary load stays one fan, with no extra round trip.
   */
  function loadChain(symbol, underlying, from, probeFirst) {
    var pages = [];
    for (var page = 0; page < OPTIONS_PAGES; page++) pages.push(page);
    // A page: its body, or { notServed } with why it was not served (the
    // status; `unreadable` for a body that is not JSON).
    var fetchPage = function (page) {
      var segments = ['mp', 'unicornbay', 'options', 'contracts'];
      var params = {
        // get() encodes keys, so the brackets arrive correctly encoded.
        'filter[underlying_symbol]': underlying,
        // This feed keeps expired contracts back to 2023. Without both of
        // these the chain opens on a three-year-old expiry.
        'filter[exp_date_from]': from,
        sort: 'exp_date',
        'page[limit]': OPTIONS_PAGE_SIZE,
        'page[offset]': page * OPTIONS_PAGE_SIZE,
      };
      // `why`: a page not served says why instead of answering null.
      return API._request(segments, params, { why: true }).then(function (body) { return body || { notServed: {} }; });
    };
    var served = function (b) { return Boolean(b) && !b.notServed; };
    // Served AND a list of contracts. A 200 with another shape -- an error
    // envelope such as {"message": "temporarily unavailable"} -- is not "no
    // options": it is an answer the app could not read.
    var listed = function (b) { return served(b) && Array.isArray(b.data); };
    var answered = probeFirst
      ? fetchPage(0).then(function (first) {
        if (!listed(first)) return [first];
        if (first.data.length < OPTIONS_PAGE_SIZE) return [first];
        return Promise.all(pages.slice(1).map(fetchPage)).then(function (rest) { return [first].concat(rest); });
      })
      : Promise.all(pages.map(fetchPage));

    return answered.then(function (bodies) {
      // The first page decides between "no options" and "not served": it
      // answered with no contracts ({"meta":{"total":0},"data":[]}) and the
      // ticker has none, whatever the later pages did; it was not served,
      // and nothing is known.
      if (!served(bodies[0])) return notServedChain(symbol, bodies[0] && bodies[0].notServed);
      if (!listed(bodies[0])) return notServedChain(symbol, { unreadable: true });
      var pagesData = bodies.map(function (b) { return listed(b) ? b.data : []; });
      if (!pagesData[0].length) return Object.assign(optionsEnvelope(symbol, []), { complete: true });
      // Whole, when every page answered and the last one was not full: there
      // are then no later expiries to ask for, and the view does not offer
      // to. A page that was not served leaves it unknown, which is "no".
      var whole = bodies.every(listed)
        && pagesData[pagesData.length - 1].length < OPTIONS_PAGE_SIZE;
      var rows = [];
      pagesData.forEach(function (batch) { rows.push.apply(rows, batch); });

      var cut = pagesData[pagesData.length - 1].length === OPTIONS_PAGE_SIZE;
      if (cut) {
        console.warn('[EODHD] options chain for ' + underlying + ' was cut at ' + rows.length
          + ' contracts — later expiries are loaded when picked');
      }

      // Pages overlap. The feed sorts on exp_date alone -- it refuses a
      // second key and refuses to sort by contract -- so the order of the
      // contracts inside one expiry differs from one request to the next, and
      // an expiry that straddles a page boundary comes back with some
      // contracts twice and others not at all. Measured on SPY: 142 of 4,000
      // rows duplicated, and 2026-10-12 had 9 calls against 151 puts, with
      // nothing on screen to say so. The expiries outside a
      // boundary are complete -- their positions all fall inside one page --
      // so only the straddling ones, and the last one of a chain that was cut
      // mid-expiry, are fetched again whole, one request each, in parallel.
      var redo = expiriesToRefetch(pagesData, cut);
      if (!redo.length) return Object.assign(optionsEnvelope(symbol, rows), { complete: whole });
      return Promise.all(redo.map(function (date) {
        return API.getOptionsExpiry(null, symbol, date).then(function (entry) {
          return { date: date, entry: entry };
        }, function () { return { date: date, entry: null }; });
      })).then(function (filled) {
        var envelope = Object.assign(optionsEnvelope(symbol, rows), { complete: whole });
        filled.forEach(function (f) {
          var complete = f.entry && ((f.entry.options.CALL || []).length + (f.entry.options.PUT || []).length);
          envelope.data = envelope.data.map(function (d) {
            if (d.expirationDate !== f.date) return d;
            // A failed refetch leaves the expiry empty rather than partial:
            // the view then fetches it on its own when it is picked, which a
            // partial one it would never do.
            return complete ? f.entry : { expirationDate: f.date, options: { CALL: [], PUT: [] } };
          });
        });
        return envelope;
      });
    });
  };

  /**
   * The expiry dates a fan of pages may have left incomplete: any date on
   * both sides of a page boundary, and the last date of a chain cut by the
   * page cap. Exposed for the generator's tests.
   */
  function expiriesToRefetch(pagesData, cut) {
    function dateOf(row) {
      var a = (row && row.attributes) || row;
      return a && a.exp_date;
    }
    var dates = [];
    function add(d) { if (d && dates.indexOf(d) === -1) dates.push(d); }
    for (var i = 0; i + 1 < pagesData.length; i++) {
      var here = pagesData[i];
      var next = pagesData[i + 1];
      if (here.length !== OPTIONS_PAGE_SIZE || !next.length) continue;
      var lastHere = dateOf(here[here.length - 1]);
      if (lastHere && lastHere === dateOf(next[0])) add(lastHere);
    }
    if (cut) {
      var tail = pagesData[pagesData.length - 1];
      add(dateOf(tail[tail.length - 1]));
    }
    return dates;
  }
  API._optionsExpiriesToRefetch = expiriesToRefetch;
})();
