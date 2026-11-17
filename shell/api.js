/**
 * The data client the vendored modules call.
 *
 * The terminal's own client is sixty kilobytes: two data paths, a demo mode, a
 * proxy-or-direct decision, thirty-odd methods, and a key threaded through
 * every one of them. None of that is needed here. There is one path -- through
 * the local proxy on this machine -- and no key on this side of it.
 *
 * Methods keep their apiKey first argument because the modules pass it, and
 * ignore it because there is nothing to pass. A test on the generator's side
 * pins that: the day the argument starts being used is the day a key appears
 * in a browser URL.
 *
 * Only the endpoints the vendored modules actually reach for are here. A
 * sample app should be readable end to end in a sitting, and twenty-five
 * unused methods would work against that.
 */
(function () {
  var BASE = '/api';

  // Which capability an endpoint belongs to, so a 403 can be attributed. The
  // upstream sentence names the feed; this names the thing in our own app that
  // stopped working.
  var CAPABILITY = {
    'options': 'options',
    'real-time': 'realtime',
    'search': 'core',
    'mp': 'marketplace',
    'news': 'news',
    'sentiments': 'sentiment',
    'screener': 'screener',
    'calendar': 'calendar',
    'economic-events': 'macro',
    // Dividends are named as such, wherever they come from: a refusal on
    // them was filed under 'eod' or 'calendar' and the panel above the
    // calendar could not say which feed was missing.
    'div': 'dividends',
    'eod': 'eod',
    // Form 4 insider filings are part of the fundamentals data, not the core API.
    'sec-filings': 'fundamentals',
    // The calendar's company names: a refusal costs it only
    // the joining of mirror lines, so the calendar keeps it silent.
    'exchange-symbol-list': 'exchange_lists',
    // An exchange's hours and holidays, apart from the core API: filed
    // under 'core', a refusal of the hours read as one of the ticker search,
    // and a failure of one took the other's place.
    'exchange-details': 'exchanges',
  };

  /**
   * v1 /exchange-details in the v2 shape exchangeStatus.js reads.
   *
   * They are not the same payload. v1 keys ExchangeHolidays by index ("0",
   * "1", ...) and keeps half-days apart in ExchangeEarlyCloseDays with
   * {EarlyClose: "13:00"}; v2 keys both by date and types the half-day
   * "EarlyClose". Handed over raw, exchangeStatus looked for hol["2026-11-26"]
   * and never found a holiday: the calendar's Holidays tab was always empty,
   * the heatmap traded through Thanksgiving, and getNextHoliday compared "3"
   * with a date and returned July. This is the terminal's _v1ExchangeToV2.
   *
   * v1 also has no extended hours, so before 09:30 New York read "closed"
   * rather than pre-market. For US -- the only exchange these apps quote
   * outside regular hours -- the published session times are filled in when
   * v1 leaves them out.
   */
  // No letter or digit in it: "..", ".", "-", "". Not a symbol of anything.
  function namesNothing(segment) {
    return !/[A-Za-z0-9]/.test(String(segment == null ? '' : segment));
  }

  var US_EXTENDED = { PreMarketOpen: '04:00:00', PreMarketClose: '09:30:00', AfterHoursOpen: '16:00:00', AfterHoursClose: '20:00:00' };

  function v1ExchangeToV2(d, exchange) {
    var out = {};
    Object.keys(d).forEach(function (k) {
      if (k !== 'ExchangeEarlyCloseDays' && k !== 'isOpen') out[k] = d[k];
    });
    var hol = {};
    [d.ExchangeHolidays, d.ExchangeEarlyCloseDays].forEach(function (src) {
      var items = Array.isArray(src) ? src : (src && typeof src === 'object' ? Object.keys(src).map(function (k) { return src[k]; }) : []);
      items.forEach(function (e) {
        if (!e || !e.Date) return;
        var day = String(e.Date).slice(0, 10);
        var early = e.EarlyClose || null;
        if (early && early.length === 5) early += ':00';
        hol[day] = early
          ? { Holiday: e.Holiday || e.Name, Type: 'EarlyClose', EarlyClose: early }
          : { Holiday: e.Holiday || e.Name, Type: e.Type || 'Official' };
      });
    });
    out.ExchangeHolidays = hol;
    if (String(exchange).toUpperCase() === 'US' && out.TradingHours && typeof out.TradingHours === 'object') {
      var th = {};
      Object.keys(out.TradingHours).forEach(function (k) { th[k] = out.TradingHours[k]; });
      Object.keys(US_EXTENDED).forEach(function (k) { if (!th[k]) th[k] = US_EXTENDED[k]; });
      out.TradingHours = th;
    }
    return out;
  }

  function capabilityFor(segments) {
    // The options chain lives under the marketplace prefix, and a refusal on
    // it is a refusal of options -- which is the capability the options app
    // declares and the frame watches. Attributed to 'marketplace' instead, the
    // 403 would be recorded against a capability nothing is listening for and
    // the upgrade panel would never appear.
    if (segments[0] === 'mp' && segments.indexOf('options') !== -1) return 'options';
    if (segments[0] === 'calendar' && segments[1] === 'dividends') return 'dividends';
    return CAPABILITY[segments[0]] || 'core';
  }

  /**
   * The kind of request, in the words a module's failure line names it:
   * data-own-fail="quotes" on "1 without a price", "history" on the
   * Backtest's line, "exchange-hours" on the market hours'. Entitlement
   * keeps each failure under it, and the panel leaves to the screen what a
   * line on the page names (shell/entitlement.js, said()). A capability is
   * too coarse for that: the fundamentals, the ticker search and the
   * economic data are all the core API.
   */
  var WHATS = {
    'real-time': 'quotes',
    'us-quote-delayed': 'quotes',
    'eod': 'history',
    'v1.1': 'fundamentals',
    'fundamentals': 'fundamentals',
    'sec-filings': 'insider',
    'macro-indicator': 'macro',
    'exchange-details': 'exchange-hours',
    'exchange-symbol-list': 'company-names',
    'screener': 'screener',
    'news': 'news',
    'sentiments': 'sentiment',
    'search': 'search',
    'economic-events': 'economic-events',
    'div': 'dividends',
  };
  // The calendar's own feeds, the marketplace's products.
  var MORE_WHATS = ['earnings', 'dividends', 'splits', 'ipos', 'options-chain', 'index-list', 'index-constituents'];
  function whatOf(segments) {
    var s = segments || [];
    if (s[0] === 'mp') {
      if (s.indexOf('options') !== -1) return 'options-chain';
      var at = s.indexOf('spglobal');
      if (at !== -1) return s[at + 1] === 'comp' ? 'index-constituents' : 'index-list';
      return 'marketplace';
    }
    if (s[0] === 'calendar') return String(s[1] || 'calendar');
    return Object.prototype.hasOwnProperty.call(WHATS, s[0]) ? WHATS[s[0]] : String(s[0] || '');
  }
  // Every kind there is, for the generator's check of the modules' marks.
  function allWhats() {
    var out = MORE_WHATS.slice();
    Object.keys(WHATS).forEach(function (k) { if (out.indexOf(WHATS[k]) === -1) out.push(WHATS[k]); });
    return out;
  }

  // Fundamentals without Morningstar's fields: the same rule the terminal
  // applies in its own client and on its server, and server/proxy.js here.
  function stripMorningstar(data) {
    if (Array.isArray(data)) return data.map(stripMorningstar);
    if (!data || typeof data !== 'object') return data;
    var fundLike = /^(ETF|FUND)$/i.test(String(data.Type || '')) || 'Fund_Category' in data || 'Nav' in data;
    var out = {};
    Object.keys(data).forEach(function (k) {
      // Relative_to_Category and Valuations_Growth's *_Rates_To_Category are
      // comparisons with Morningstar's category; *_Rates_Portfolio stay.
      if (/morning_?star|(?:relative|rates)_to_category/i.test(k)) return;
      if (fundLike && (k === 'Category' || k === 'Fund_Category' || k === 'Fund_Style')) return;
      out[k] = stripMorningstar(data[k]);
    });
    return out;
  }

  /**
   * One request, through the proxy.
   *
   * The path arrives as segments rather than a string, so a symbol containing
   * a slash becomes one encoded segment instead of extra path. Building it by
   * concatenation looked fine and was not: '..' survives
   * encodeURIComponent untouched, because a dot is not a character it encodes.
   *
   * Returns null on anything that is not a 200. These results are rendered
   * directly, so throwing would surface as a blank screen rather than as the
   * panel that explains what happened.
   */
  function get(segments, params, opts) {
    return answerOf(segments, params, opts).then(function (answer) {
      if (!answer || !answer.ok) return null;
      var d;
      try { d = JSON.parse(answer.body); } catch (_) { return null; }
      return notData(d) ? null : d;
    });
  }

  /**
   * A 200 that carries no data: a body that is a message and nothing else
   * -- {"message": "temporarily unavailable"} -- is an answer that could
   * not be read, the same as an HTML page with 200. Read as data it was a
   * quote of "NA", a rate that was not there, a day with no close, "no
   * insider transactions". RateLimitWait.notData's rule, the
   * terminal's: every key one of a message's, so a real answer that also
   * has a `message` field is still an answer. `shape` adds what the
   * endpoint's answer must be, as the terminal's client checks it: 'quote'
   * (a quote, or a list of them), 'list' (rows that are objects, none a
   * bare message), 'object' (fundamentals).
   */
  var MESSAGE_KEYS = { message: 1, status: 1, statusCode: 1, success: 1, detail: 1 };
  function notData(body, shape) {
    var plain = body && typeof body === 'object' && !Array.isArray(body);
    var message = function (x) {
      if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
      if (x.unreadable === true) return true;
      if (typeof x.message !== 'string') return false;
      return Object.keys(x).every(function (k) { return MESSAGE_KEYS[k] === 1; });
    };
    if (message(body)) return true;
    if (shape === 'quote') return !(Array.isArray(body) || (plain && (body.code != null || body.close != null || body.timestamp != null)));
    if (shape === 'list') return !(Array.isArray(body) && body.every(function (x) { return x && typeof x === 'object' && !Array.isArray(x) && !message(x); }));
    if (shape === 'object') return !plain;
    return false;
  }

  /**
   * get() for a caller that passes { throwErrors: true }, as the terminal's
   * client takes it: the data, or an Error with the answer's status (0 when
   * nothing came back; 429 inside the per-minute wait, when nothing is sent).
   * The Backtest passed it and this side dropped it, so a 404, a refused
   * plan and the limit all read "did not load -- EODHD did not answer".
   * `what` names the request in the message.
   */
  // `shape`: what the answer must be (notData); a body of another shape is
  // unreadable too, with its status. `opts`: answerOf's.
  function getOrStatus(segments, params, what, shape, opts) {
    return answerOf(segments, params, opts).then(function (answer) {
      if (noAnswer(answer)) throw failedError(what + ' did not answer', answer);
      if (!answer.ok) throw failedError(what + ' answered ' + answer.status, answer);
      var d;
      try { d = JSON.parse(answer.body); } catch (_) { throw unreadable(what + ' answered something unreadable', answer.status); }
      if (notData(d, shape)) throw unreadable(what + ' answered something unreadable', answer.status);
      return d;
    });
  }

  /**
   * What a request that was not served was, in the fields the terminal's
   * client gives a failure (its _failedOf), so a vendored module reads the
   * two the same way: the HTTP status, 0 when nothing came back;
   * `rateLimited` for the per-minute limit (a 429, or a request held inside
   * its wait); `unreadable` for an answer that could not be read;
   * `timedOut` (name "TimeoutError") for a request this side gave up on;
   * and `dailyLimit` for a 402 that is the day's allowance, not the plan.
   * The exchange's status read none of it: { error: 'not served' } made a
   * 500 "did not answer" and a refusal of the plan a dropped connection.
   */
  function failedOf(answer, isUnreadable) {
    var a = answer || {};
    var out = { status: Number(a.status) || 0 };
    if (out.status === 429) out.rateLimited = true;
    if (out.status === 402 && window.Entitlement && window.Entitlement.isLimitBody && window.Entitlement.isLimitBody(a.body)) out.dailyLimit = true;
    if (a.timedOut) { out.timedOut = true; out.name = 'TimeoutError'; }
    if (isUnreadable) out.unreadable = true;
    return out;
  }
  // The same, on an Error for a caller that throws.
  function failedError(message, answer) {
    var e = new Error(message);
    var why = failedOf(answer);
    Object.keys(why).forEach(function (k) { if (k !== 'name') e[k] = why[k]; });
    if (why.name) e.name = why.name;
    return e;
  }
  // A request that left and got nothing back (dropped, timed out), or one
  // never asked (a symbol that names nothing).
  function noAnswer(answer) { return !answer || answer.none === true; }

  /**
   * An answer that came back and could not be read -- an HTML page served
   * with 200, JSON of another shape. Marked as such (`unreadable`), with
   * the answer's status: thrown without one, the screener read it as a
   * dropped connection, "EODHD did not answer".
   * RateLimitWait.failure() reads the mark.
   */
  function unreadable(message, status) {
    var e = new Error(message || 'Invalid response from API');
    e.unreadable = true;
    if (status) e.status = status;
    return e;
  }

  /**
   * How a request's failure is recorded (Entitlement.fromResponse): its kind
   * (whatOf), and whether a line of the screen's may come for it, so the
   * panel waits a moment for that line rather than come up and go (`wait`):
   * the caller says so (opts.wait, or opts.reportsFailure), or the app's
   * screens name that kind of failure themselves without asking the panel
   * (meta.json lineKinds: the portfolio's "1 without a price", its Backtest,
   * the market hours under the heatmap). Who says a failure is decided on
   * the page, by the lines' data-own-fail, never by this: a list of each
   * line's words per app decided it, and every line not in it had the panel
   * over it. `part`: data of the same set came (shell/options.js).
   * `what`: the kind, where the request serves another (getScreenerData).
   * `idle`: a function that says no screen uses the request now (an
   * exchange's hours under the heatmap's Crypto tab).
   */
  function asking(segments, opts, params) {
    var o = opts || {};
    var what = o.what || whatOf(segments);
    var kinds = window.APP_META && window.APP_META.lineKinds;
    var wait = o.wait !== undefined ? o.wait : (Boolean(o.reportsFailure) || Boolean(kinds && kinds.indexOf(what) !== -1));
    return { what: what, wait: wait || null, part: o.part || laterPage(params) || null, idle: o.idle || null };
  }
  // A page after the first of a set the caller pages through itself (the
  // screener's results, the calendar's market caps): what came before it
  // is on screen, so its failure leaves something below partial. The panel
  // said "Nothing below is missing data" over the first page's companies.
  function laterPage(params) {
    if (!params) return false;
    var at = Number(params.offset != null ? params.offset : params['page[offset]']);
    return Number.isFinite(at) && at > 0;
  }

  /**
   * A refusal of the key, the day or the plan (401, 402, 403), by address:
   * the same request is answered the same way from here for the page's
   * life, without asking EODHD again. The calendar asked one exchange's
   * refused list three times in 25 s, and the panel came and went with
   * each; a refused key is not accepted on the next try either, and a spent
   * day does not come back before midnight. Another request -- another
   * symbol, another month -- is asked as any other.
   */
  var refusedAt = {};
  // The query of an address, as an object (for laterPage).
  function queryOf(path) {
    var out = {};
    var q = String(path).split('?')[1] || '';
    q.split('&').forEach(function (pair) {
      if (!pair) return;
      var at = pair.indexOf('=');
      try { out[decodeURIComponent(at === -1 ? pair : pair.slice(0, at))] = at === -1 ? '' : decodeURIComponent(pair.slice(at + 1)); } catch (_) { /* as it came */ }
    });
    return out;
  }
  function refusal(status) { return status === 401 || status === 402 || status === 403; }

  /**
   * get(), before the parse: { ok, status, body }, or null when nothing was
   * asked or nothing came back. For the one caller that has to tell "there
   * is no such thing" from "it was not served" (getExchangeHolidaysV2).
   * opts: asking()'s (wait, reportsFailure, part), softDenial, fresh.
   */
  function answerOf(segments, params, opts) {
    // A symbol has to name something. ".." and "-" passed the views' own
    // patterns (dots and dashes are legal inside a ticker), and then cost
    // real requests: the browser folded "/spglobal/.." into a paid call for
    // the whole index list, "-" sent six options requests, and news asked for
    // the sentiment of "..". Such a segment answers what an unknown symbol
    // answers -- nothing -- without leaving the browser; in a list (s=A,..,B)
    // the empty names are dropped and the rest are asked for.
    for (var i = 1; i < segments.length; i++) {
      if (namesNothing(segments[i])) return Promise.resolve(null);
    }
    if (params && typeof params.s === 'string' && params.s.indexOf(',') !== -1) {
      var named = params.s.split(',').filter(function (t) { return !namesNothing(t); });
      if (!named.length) return Promise.resolve(null);
      params = Object.assign({}, params, { s: named.join(',') });
    } else if (params && typeof params.s === 'string' && params.s && namesNothing(params.s)) {
      return Promise.resolve(null);
    }
    var capability = capabilityFor(segments);
    // softDenial: a 403 on a feed that has already answered 200 is about the
    // thing asked for, not the plan (see getIndexComponents).
    var soft = Boolean(opts && opts.softDenial);
    var url = BASE + '/' + segments.map(encodeURIComponent).join('/');
    var query = [];
    var merged = params || {};
    merged.fmt = merged.fmt || 'json';
    for (var k in merged) {
      if (Object.prototype.hasOwnProperty.call(merged, k) && merged[k] != null) {
        query.push(encodeURIComponent(k) + '=' + encodeURIComponent(merged[k]));
      }
    }
    if (query.length) url += '?' + query.join('&');

    // The same request already on its way is joined, not repeated. The
    // heatmap's Pre-Market switch sent us-quote-delayed twice with the same
    // body, at the same moment: the view asks
    // twice for one click, and the second request went out before the first
    // had answered. On the free tier's twenty a day that is a
    // tenth of the budget per click. Each caller still gets its own parse,
    // so one mutating its result cannot change another's.
    //
    // A retry is not a duplicate. "Try again" pressed while the first
    // request still hung joined it, and timed out with it 25 s later:
    // opts.fresh, or EODHD_API.fresh() before the retry, sends a new
    // request. The old one still answers its own callers.
    //
    // Not every retry says so: the portfolio's "Try again" and a second
    // "Run Backtest" are vendored code that calls neither. So a request is
    // joined only while it is young (JOIN_WINDOW_MS): two asks from one click
    // land within it, a person pressing again does not.
    var key = (soft ? 'soft ' : '') + url;
    var entry = (opts && opts.fresh) ? null : inFlight[key];
    if (entry && Date.now() - entry.startedAt < JOIN_WINDOW_MS) return entry.promise;
    var mine = { promise: send(url, capability, soft, asking(segments, opts, merged)), startedAt: Date.now() };
    inFlight[key] = mine;
    // Only its own entry: a request left behind by a newer one must not
    // take the newer one off the table when it finally settles.
    var done = function () { if (inFlight[key] === mine) delete inFlight[key]; };
    mine.promise.then(done, done);
    return mine.promise;
  }

  var inFlight = {};
  var JOIN_WINDOW_MS = 3000;
  // How many screens have been left (EODHD_API.screen).
  var screenMark = 0;

  // EODHD's per-minute limit. After a 429 nothing is sent until the wait is
  // over (Retry-After when the answer gives one, else a minute): "Try again"
  // inside the minute sent the calendar's nine requests, the heatmap's two
  // and the index page's one straight into the same limit, under a panel
  // asking to wait. The views are answered as the 429 was, so they keep
  // saying why.
  var LIMIT_WAIT_MS = 60000;
  // A Retry-After past this is read as a mistake, not as a reason to go
  // quiet for an hour.
  var LIMIT_WAIT_MAX_MS = 600000;
  var limitedUntil = 0;
  // Retry-After is seconds or an HTTP date (RFC 9110). Missing or
  // unreadable: a minute. 0, or a date already past (a clock ahead of the
  // server's), counts as missing too: read as "no wait", it let every Try
  // again go straight into the same 429.
  function retryAfterMs(value) {
    var v = value == null ? '' : String(value).trim();
    var ms = NaN;
    if (/^\d+$/.test(v)) ms = Number(v) * 1000;
    else if (v) ms = Date.parse(v) - Date.now();
    return Number.isFinite(ms) && ms > 0 ? ms : LIMIT_WAIT_MS;
  }
  function noteLimit(status, retryAfter) {
    if (status !== 429) return;
    var ms = Math.min(retryAfterMs(retryAfter), LIMIT_WAIT_MAX_MS);
    var was = limitedUntil;
    limitedUntil = Math.max(limitedUntil, Date.now() + ms);
    // A Try again already on screen counts down at once, whichever request
    // met the limit (RateLimitWait.useWait listens).
    if (limitedUntil > was) {
      try { window.dispatchEvent(new CustomEvent('api:rate-limited', { detail: { until: limitedUntil } })); } catch (_) {}
    }
  }
  function limited() { return Date.now() < limitedUntil; }
  var HELD_BODY = JSON.stringify({ message: 'Too Many Requests' });
  // The index codes the S&P Global list answered with, upper case without
  // ".INDX"; null until it has answered. See getIndexComponents.
  var servedIndexCodes = null;
  function indexCode(code) { return String(code || '').replace(/\.INDX$/i, '').toUpperCase(); }
  // Exchanges whose details were not served: from which mark on an answer
  // makes them worth asking again, and why they were not.
  var notServed = {};
  // Exchanges whose details were refused (401, 402, 403), and how: answered
  // so for the page's life, never asked again (refusedAt).
  var refusedExchanges = {};
  /**
   * Exchange details that were not served, in the shape the terminal's
   * client answers them (getExchangeHolidaysV2's miss()) and ExchangeStatus
   * reads: a failure kept and asked again, with its status (`_status`, none
   * when nothing came back) -- not "no such exchange", which is _notFound
   * alone. It was { error: 'not served' }, with no status: a 500 read "did
   * not answer, or the connection dropped", a refusal of the plan the same,
   * and both were asked again as an outage.
   */
  function notServedBody(why) {
    var w = why || {};
    var body = { _notFound: true, _failed: true };
    if (w.status) body._status = w.status;
    if (w.unreadable) body._unreadable = true;
    if (w.timedOut) body._timedOut = true;
    if (w.dailyLimit) body._dailyLimit = true;
    return body;
  }

  // How long a request may take before this side gives up: five seconds past
  // the proxy's own deadline, so the proxy's answer -- the data, or its 502
  // with the reason -- is what arrives, not an abort. The news feed is the
  // slow one (14 to 22 seconds for one symbol's headlines), and the proxy
  // allows it 45; everything else keeps 20 / 25.
  //
  // The ticker search is the quick one: somebody is typing and waiting on the
  // list. It held "Searching..." for the full 25 s when the search hung, with
  // Enter doing nothing; after 10 s the field says so and Enter asks again.
  var TIMEOUT_MS = 25000;
  var OWN_TIMEOUT_MS = { news: 50000, search: 10000 };
  function timeoutFor(url) {
    var first = String(url).slice(BASE.length + 1).split(/[/?]/)[0];
    return Object.prototype.hasOwnProperty.call(OWN_TIMEOUT_MS, first) ? OWN_TIMEOUT_MS[first] : TIMEOUT_MS;
  }

  /**
   * The network half of get(): one fetch, its answer recorded once.
   * { ok, status, body }, or, when nothing came back, { none: true, status:
   * 0, timedOut } -- a dropped connection and this side's deadline told
   * apart, as the terminal's client tells them.
   */
  // `mine`: asking()'s -- the kind of request, and whether a line may come
  // for its failure.
  function send(url, capability, soft, mine) {
    var how = mine || {};
    var E0 = window.Entitlement;
    // Refused before for the key, the day or the plan: the same answer,
    // nothing sent (refusedAt), and recorded again as the refusal it is, so
    // what the screen is told and what the panel knows stay one.
    var kept = refusedAt[url];
    if (kept) {
      var skipKept = soft && kept.status === 403 && E0 && E0.get && E0.get(capability).allowed === true;
      if (E0 && !skipKept) E0.fromResponse({ status: kept.status, body: kept.body, what: how.what, wait: how.wait, part: how.part, idle: how.idle, kept: true }, capability);
      return Promise.resolve({ ok: false, status: kept.status, body: kept.body, kept: true });
    }
    // Inside the per-minute wait: answered as the 429 was, and recorded as
    // one, so a line that names it is matched to it like any other. Held
    // unrecorded, the Benchmark's "per-minute request limit was reached"
    // was a line about nothing the panel knew, and the panel said the limit
    // again over it.
    if (limited()) {
      if (E0) E0.fromResponse({ status: 429, body: HELD_BODY, what: how.what, wait: how.wait, part: how.part, idle: how.idle, held: true }, capability);
      return Promise.resolve({ ok: false, status: 429, body: HELD_BODY, held: true });
    }
    // A deadline on this side too. The proxy has one, but a request that
    // never resolves here leaves the view on "Loading…" with nothing to say.
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timedOut = false;
    var timer = controller ? setTimeout(function () { timedOut = true; controller.abort(); }, timeoutFor(url)) : null;
    var clear = function () { if (timer) clearTimeout(timer); };
    // When it left, in Entitlement's count: a success settles the key's
    // earlier problems only if it was asked for after them.
    var sent = E0 && E0.mark ? E0.mark() : null;

    // Marked, so the wrapper below does not record the same answer a second
    // time: this function records it itself, and softDenial depends on being
    // the only one that does.
    return fetch(url, controller ? { signal: controller.signal, eodhdShell: true } : { eodhdShell: true })
      .then(function (res) {
        clear();
        noteLimit(res.status, res.headers && res.headers.get && res.headers.get('retry-after'));
        return res.text().then(function (body) {
          var E = window.Entitlement;
          if (refusal(res.status)) refusedAt[url] = { status: res.status, body: body };
          var skip = soft && res.status === 403 && E && E.get && E.get(capability).allowed === true;
          if (E && !skip) {
            E.fromResponse({ status: res.status, body: body, sent: sent, what: how.what, wait: how.wait, part: how.part, idle: how.idle }, capability);
          }
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .catch(function () {
        clear();
        // A connection that never completed is a problem the page should
        // name, same as a 500 -- status 0, the way browsers report it.
        if (window.Entitlement) window.Entitlement.fromResponse({ status: 0, body: '', sent: sent, what: how.what, wait: how.wait, part: how.part, idle: how.idle }, capability);
        return { ok: false, none: true, status: 0, body: '', timedOut: timedOut };
      })
      .then(released(sent), releasedOnError(sent));
  }

  // Every request that took a mark gives it back, however it ends: served,
  // refused, broken off, timed out, or with a body that would not read. One
  // left out stays "in flight" for ever, and Entitlement.servedSince() --
  // which waits for the requests in flight to settle -- waited with it.
  // Recording an answer gives the mark back already; these are for the
  // paths that record nothing (a soft denial, a body that threw).
  function release(sent) {
    if (sent != null && window.Entitlement && window.Entitlement.release) window.Entitlement.release(sent);
  }
  function released(sent) { return function (value) { release(sent); return value; }; }
  function releasedOnError(sent) { return function (err) { release(sent); throw err; }; }

  /**
   * Notice a refusal even when a module went around this file.
   *
   * Some of the vendored views build their own URL and call fetch directly --
   * the screener and the news feed both do. Patching each one is a losing
   * game: the next module added will bypass it too, and the failure is silent,
   * a 403 that renders as "Invalid response from API" while the panel that
   * explains it never appears.
   *
   * So the interception is here instead, once, on the way past. The response
   * is cloned before reading, so nothing the caller does afterwards changes.
   *
   * The record is written before the response is handed back. It used to be
   * fired and forgotten -- clone().text().then(record) -- and the screener's
   * own catch block asked anyDenied() one tick before the refusal landed, so
   * the same sentence appeared twice: grey in the panel and red below it
   *. A 200 is recorded without reading the body; the others
   * carry their reason in it.
   */
  var nativeFetch = window.fetch && window.fetch.bind(window);
  if (nativeFetch && !window.__eodhdEntitlementWatch) {
    window.__eodhdEntitlementWatch = true;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || (input && input.href) || String(input || '');
      // A path, an absolute URL on this origin, a URL or a Request object
      // (an absolute URL went past the 429 hold).
      var path = url;
      try {
        var resolved = new URL(url, window.location.href);
        path = resolved.origin === window.location.origin ? resolved.pathname + resolved.search : '';
      } catch (_) { /* as it came */ }
      var own = path.indexOf(BASE + '/') === 0 && path.indexOf(BASE + '/_') !== 0;
      var shell = Boolean(init && init.eodhdShell);
      var segments = own ? path.slice(BASE.length + 1).split('?')[0].split('/') : [];
      var capability = own ? capabilityFor(segments) : null;
      var how = own ? asking(segments, null, queryOf(path)) : {};
      // A module's own request refused before for the key, the day or the
      // plan is answered the same way, without leaving the browser
      // (refusedAt).
      var kept = own && !shell ? refusedAt[path] : null;
      if (kept && typeof Response === 'function') {
        if (window.Entitlement) window.Entitlement.fromResponse({ status: kept.status, body: kept.body, what: how.what, wait: how.wait, kept: true }, capability);
        return Promise.resolve(new Response(kept.body, { status: kept.status, headers: { 'content-type': 'application/json' } }));
      }
      // One inside the 429 wait is answered as the 429 was (see noteLimit),
      // and recorded as one (send()).
      if (own && !shell && limited() && typeof Response === 'function') {
        if (window.Entitlement) window.Entitlement.fromResponse({ status: 429, body: HELD_BODY, what: how.what, wait: how.wait, held: true }, capability);
        return Promise.resolve(new Response(HELD_BODY, { status: 429, headers: { 'content-type': 'application/json' } }));
      }
      var promise = nativeFetch(input, init);
      if (shell) return promise;
      if (!own) return promise;

      var sent = window.Entitlement && window.Entitlement.mark ? window.Entitlement.mark() : null;
      var answered = function (status, body) {
        if (refusal(status)) refusedAt[path] = { status: status, body: body };
        window.Entitlement.fromResponse({ status: status, body: body, sent: sent, what: how.what, wait: how.wait, part: how.part }, capability);
      };
      return promise.then(function (res) {
        noteLimit(res.status, res.headers && res.headers.get && res.headers.get('retry-after'));
        if (!window.Entitlement) return res;
        if (res.status === 200) {
          window.Entitlement.fromResponse({ status: 200, body: '', sent: sent, what: how.what }, capability);
          return res;
        }
        return res.clone().text().then(function (body) {
          answered(res.status, body);
          return res;
        }, function () {
          answered(res.status, '');
          return res;
        });
      }, function (err) {
        if (window.Entitlement) window.Entitlement.fromResponse({ status: 0, body: '', sent: sent, what: how.what, wait: how.wait, part: how.part }, capability);
        throw err;
      }).then(released(sent), releasedOnError(sent));
    };
  }

  /**
   * get(), for a caller that wants to be told why.
   *
   * The screener pages through its results itself and names a failure in its
   * own words -- which needs the failure, not a null. So a non-OK answer
   * throws with upstream's sentence (or the status, when upstream sent a page
   * of markup), and a connection that never completed throws as it is. The
   * refusal is still recorded first, so the frame's panel says the same thing
   * and the view can stay quiet about it.
   */
  // `opts`: asking()'s (wait, reportsFailure).
  function getOrThrow(segments, params, opts) {
    var how = asking(segments, opts, params);
    var capability = capabilityFor(segments);
    var url = BASE + '/' + segments.map(encodeURIComponent).join('/');
    var query = [];
    var merged = params || {};
    merged.fmt = merged.fmt || 'json';
    for (var k in merged) {
      if (Object.prototype.hasOwnProperty.call(merged, k) && merged[k] != null) {
        query.push(encodeURIComponent(k) + '=' + encodeURIComponent(merged[k]));
      }
    }
    if (query.length) url += '?' + query.join('&');

    // Refused before: the same refusal, nothing sent (refusedAt), recorded
    // again (send()).
    var kept = refusedAt[url];
    if (kept) {
      if (window.Entitlement) window.Entitlement.fromResponse({ status: kept.status, body: kept.body, what: how.what, wait: how.wait, kept: true }, capability);
      return Promise.reject(failedError(refusedText(kept.status, kept.body), kept));
    }
    // Held inside the per-minute wait, and recorded as a 429 (send()).
    if (limited()) {
      if (window.Entitlement) window.Entitlement.fromResponse({ status: 429, body: HELD_BODY, what: how.what, wait: how.wait, held: true }, capability);
      return Promise.reject(failedError('Too Many Requests', { status: 429 }));
    }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timedOut = false;
    var timer = controller ? setTimeout(function () { timedOut = true; controller.abort(); }, timeoutFor(url)) : null;
    var clear = function () { if (timer) clearTimeout(timer); };
    var sent = window.Entitlement && window.Entitlement.mark ? window.Entitlement.mark() : null;

    // Marked like send(): this function records its own answer, with when it
    // was sent, and the wrapper above must not record it a second time.
    return fetch(url, controller ? { signal: controller.signal, eodhdShell: true } : { eodhdShell: true }).then(function (res) {
      clear();
      noteLimit(res.status, res.headers && res.headers.get && res.headers.get('retry-after'));
      return res.text().then(function (body) {
        if (refusal(res.status)) refusedAt[url] = { status: res.status, body: body };
        if (window.Entitlement) {
          window.Entitlement.fromResponse({ status: res.status, body: body, sent: sent, what: how.what, wait: how.wait, part: how.part }, capability);
        }
        if (!res.ok) throw failedError(refusedText(res.status, body), { status: res.status, body: body });
        var d;
        try { d = JSON.parse(body); } catch (_) { throw unreadable('Invalid response from API', res.status); }
        if (notData(d)) throw unreadable('Invalid response from API', res.status);
        return d;
      });
    }, function (err) {
      clear();
      if (window.Entitlement) window.Entitlement.fromResponse({ status: 0, body: '', sent: sent, what: how.what, wait: how.wait, part: how.part }, capability);
      // With the status a module reads (0: nothing came back) and whether
      // this side gave up on it.
      var none = failedError((err && err.message) || 'EODHD did not answer', { status: 0, timedOut: timedOut });
      throw none;
    }).then(released(sent), releasedOnError(sent));
  }
  // A fund's holdings under one filter: the object, null when the fund has
  // none (EODHD answers "NA"), or -- asked with throwErrors -- a failure
  // thrown with its status.
  function holdings(symbol, filter, what, opts) {
    var shaped = function (d) { return (d && typeof d === 'object') ? d : null; };
    if (opts && opts.throwErrors) return getOrStatus(['v1.1', 'fundamentals', symbol], { filter: filter }, what, undefined, opts).then(shaped);
    return get(['v1.1', 'fundamentals', symbol], { filter: filter }).then(shaped).catch(function () { return null; });
  }

  // Upstream's sentence for a failure, or the status when upstream sent a
  // page of markup.
  function refusedText(status, body) {
    var text = String(body || '').trim();
    if (!text || text.charAt(0) === '<' || text.length > 200) text = 'EODHD answered ' + status + '.';
    return text;
  }

  window.EODHD_API = {
    /**
     * The request helper, for the shell files that add endpoints of their own.
     *
     * shell/options.js is copied only into the app that needs it, and it has
     * to make requests the same way everything else does -- one path, through
     * the proxy, with the refusal attributed to the right capability. Kept
     * underscored because it is not part of what the vendored modules call.
     */
    //
    // opts.why: a request that was not served answers { notServed: { status,
    // unreadable } } instead of null, for a caller that has to tell an
    // answer with nothing in it from one that was not served, and say why
    // (shell/options.js: an options chain with no contracts read as a
    // failure). opts.wait, opts.part: asking()'s.
    _request: function (segments, params, opts) {
      var asked = { wait: opts ? opts.wait : undefined, part: (opts && opts.part) || null, idle: (opts && opts.idle) || null };
      if (!(opts && opts.why)) return get(segments, params, asked);
      return answerOf(segments, params, asked).then(function (answer) {
        if (!answer) return { notServed: {} };
        if (!answer.ok) return { notServed: failedOf(answer) };
        var d;
        try { d = JSON.parse(answer.body); } catch (_) { return { notServed: failedOf(answer, true) }; }
        return notData(d) ? { notServed: failedOf(answer, true) } : d;
      });
    },

    /**
     * Forget the requests still in flight, so the next call of each is sent
     * again instead of joining one that may hang. For "Try again" and other
     * retries a person presses: call it, then ask as before. The requests
     * already out still answer their own callers.
     */
    fresh: function () { inFlight = {}; },
    // The kinds of request (whatOf), for the generator's check of the
    // modules' data-own-fail marks.
    _whats: allWhats,
    _whatOf: whatOf,
    /**
     * The screen a request is asked for. The frame leaves a screen when the
     * view under it is mounted afresh (another address) and the app's tabs
     * when another is opened (shell/frame.js, shell/tabs.js); a loader with
     * a step still to take (the options chain's expiries, the exchange's
     * hours asked again) takes it only while the screen that asked is the
     * one on the page. After leaving the options screen, one expiry was
     * still asked for.
     */
    screen: function () { return screenMark; },
    leaveScreen: function () { screenMark += 1; },
    /** When EODHD's per-minute wait ends (ms since the epoch), or 0. */
    rateLimitedUntil: function () { return limited() ? limitedUntil : 0; },
    isRateLimited: function () { return limited(); },
    // For tests, which load this file once and answer 429 in one case and
    // 500 in the next.
    _clearRateLimit: function () { limitedUntil = 0; },
    // For tests, which answer one address refused in one case and served
    // in the next.
    _forgetRefusals: function () { refusedAt = {}; refusedExchanges = {}; notServed = {}; },
    // A refusal a person asks about again by hand (shell/options.js, a
    // ticker picked again): the addresses `test` says yes to are asked anew.
    _forgetRefused: function (test) {
      Object.keys(refusedAt).forEach(function (u) { if (test(u)) delete refusedAt[u]; });
    },

    // The terminal's transport for its own backend, which the screener calls
    // by name: `_proxyFetch('screener', params)`. Here it is the local proxy,
    // and like the terminal's it throws on a non-OK answer rather than
    // returning null, because the screener reports the failure itself.
    _proxyFetch: function (path, params) {
      return getOrThrow(String(path).split('/'), params);
    },
    // The terminal's direct-to-EODHD transport, which the calendar calls for
    // the screener's market caps when a key needs no proxy ("large first").
    // Here every request goes through the local proxy, so it is the same
    // call; the key argument is accepted and unused.
    _directFetch: function (path, _k, params) {
      return getOrThrow(String(path).split('/'), params);
    },
    // The terminal's allowlisted pass-through, which the calendar uses for the
    // exchanges' symbol lists. The same local proxy here. A list that did
    // not come is the calendar's own line, "Company names did not load",
    // with its Try again.
    _genericProxyFetch: function (path, params) {
      return getOrThrow(String(path).split('/'), params);
    },

    // The first argument is the module's apiKey. It is accepted and unused.
    // opts.throwErrors (the terminal's signature): a failure throws with its
    // status, so the page names a 500 as one.
    getIndexList: function (_k, opts) {
      var asked = opts && opts.throwErrors
        ? getOrStatus(['mp', 'unicornbay', 'spglobal', 'list'], null, 'The index list request')
        : get(['mp', 'unicornbay', 'spglobal', 'list']);
      return asked.then(function (list) {
        if (Array.isArray(list)) {
          servedIndexCodes = {};
          list.forEach(function (idx) {
            var code = indexCode(idx && (idx.Code || idx.ID));
            if (code) servedIndexCodes[code] = true;
          });
        }
        return list;
      });
    },
    /**
     * One index's members. The marketplace answers an index it does not know
     * with the same 403 it uses for a plan without the add-on -- "Forbidden.
     * Please contact support@..." -- and every 403 is a plan verdict to the
     * frame, so `#?index=NOPE.INDX` on a paid key read "Not included in this
     * plan". A code the served list does not carry is that case: no verdict is
     * recorded, and the caller gets its null as before.
     *
     * A code the list does carry is not. Its 403 is EODHD refusing this key
     * the index, and it used to be swallowed the same way: the view had
     * nothing to show but "did not load -- EODHD did not answer, or the
     * connection dropped", a fake outage where the panel should have said
     * what the plan does not include. Before the list has answered there is
     * nothing to tell the two apart, and the refusal is soft as before.
     */
    getIndexComponents: function (_k, symbol) {
      var known = servedIndexCodes && servedIndexCodes[indexCode(symbol)];
      // An answer that is no JSON (an HTML page with 200) could not be
      // read: said as that by the view ({ unreadable }), not as no answer.
      // One not served says why, as the terminal's client answers it: {
      // error, status, ... } (failedOf). It was null for all of them, and a
      // 403 for a plan without the add-on read "EODHD did not answer, or the
      // connection dropped" where the view can say the list is not
      // included in this plan. Null only when nothing was asked.
      return answerOf(['mp', 'unicornbay', 'spglobal', 'comp', symbol], null, known ? undefined : { softDenial: true }).then(function (answer) {
        if (!answer) return null;
        if (noAnswer(answer) || !answer.ok) return Object.assign({ error: 'not_served' }, failedOf(answer));
        var d;
        try { d = JSON.parse(answer.body); } catch (_) { return { error: 'unreadable', unreadable: true }; }
        return notData(d) ? { error: 'unreadable', unreadable: true } : d;
      });
    },
    // opts.throwErrors: a failure throws with its status, as the terminal's
    // does, so "no such code" (404) is told from "nothing known" (a 5xx, no
    // answer, the limit). SymbolCode.listed checks a typed listing this way:
    // with null for all three, a 500 or a dropped connection read "No
    // listing found" for a code that trades.
    // The terminal's: the last priced quote seen for a symbol, which What-If
    // keeps using at the limit. The open apps keep none: null.
    lastQuote: function () { return null; },
    // The terminal's: whether a failure is its server refusing the symbol
    // itself (a 400 naming "s" or "symbol"; it will not pass "&" or "%" on),
    // which the portfolio says as "not available" with no Try again. The
    // open apps' proxy has no such guard and no failure here names a
    // parameter: asked the same, it answers the same.
    notAvailable: function (err) {
      return Boolean(err && typeof err === 'object' && Number(err.status) === 400 && (err.parameter === 's' || err.parameter === 'symbol'));
    },
    // Asked with throwErrors, a quote's failure is named where it was asked
    // for: a typed code's check under its field, the portfolio's "without a
    // price", What-If's and Macro's lines.
    getRealTimeData: function (_k, symbol, opts) {
      if (opts && opts.throwErrors) return getOrStatus(['real-time', symbol], null, 'The quote', 'quote', opts);
      // Asked plainly, the quote answers null and its caller cannot say why:
      // the screen's only where the caller says it says it.
      return get(['real-time', symbol], null, opts);
    },
    // throwErrors: the sentiment view tells "no such ticker" from "the
    // search did not answer" (a 500, no connection) and offers to ask again;
    // with get()'s null for both it said "No ticker matches" next to the
    // shell's own "EODHD did not answer". A query that names nothing is
    // still no match, asked of nobody.
    searchStocks: function (_k, query, opts) {
      // The search for a full code is the check of that code: the answer is
      // noted, so Enter after it is not a second metered search for the same
      // code (SymbolCode.noteSearch). A failed search is not noted.
      var note = function (rows) {
        try {
          if (Array.isArray(rows) && window.SymbolCode && window.SymbolCode.noteSearch) window.SymbolCode.noteSearch(query, rows);
        } catch (_) { /* a note never breaks a search */ }
        return rows;
      };
      if (!(opts && opts.throwErrors)) return Promise.resolve(get(['search', query])).then(note);
      if (namesNothing(query)) return Promise.resolve([]);
      // The error carries the status, so the view can tell the key or the
      // plan (401, 402, 403) and the per-minute limit (429) from no answer
      // (0, 5xx): it offered "Press Enter to try again" next to "Not included
      // in this plan", and every Enter asked again, a 429 included.
      // The panel waits for the field's note only where every search of the
      // app says one (meta.json lineKinds; or a caller's reportsFailure).
      // The options chain's autocomplete answers a 500 by clearing its
      // list and saying nothing, with the same arguments as Enter's check
      // that does say it: waited for there, the panel came late to a
      // failure no line would name.
      // A search this side gave up on says so (timedOut), and the field
      // says it took too long.
      return answerOf(['search', query], null, opts).then(function (answer) {
        if (noAnswer(answer)) throw failedError('The ticker search did not answer', answer);
        if (!answer.ok) throw failedError('The ticker search answered ' + answer.status, answer);
        var rows;
        try { rows = JSON.parse(answer.body); } catch (_) { throw unreadable('The ticker search answered something unreadable', answer.status); }
        // No match is []; anything else -- an error envelope sent with 200 --
        // is a failed search, not "No ticker matches".
        if (!Array.isArray(rows)) throw unreadable('The ticker search answered something unreadable', answer.status);
        return note(rows);
      });
    },

    // Signatures match the terminal's, because the vendored modules call them
    // and are copied verbatim. Only the body changes.
    getNews: function (_k, symbol, limit, opts) {
      var p = { limit: limit || 10 };
      if (symbol) p.s = symbol;
      var o = opts || {};
      if (o.offset) p.offset = o.offset;
      if (o.from) p.from = o.from;
      if (o.to) p.to = o.to;
      // The topic tag. The news view sets it for every tab but "All" -- Tech,
      // Earnings, Economy and seven more -- and this copied the other three
      // options only, so each tab sent the same request and showed the same
      // headlines.
      if (o.t) p.t = o.t;
      // throwErrors: a failure throws with its status, as the terminal's
      // does; the views passed it and read the null the same way, so this
      // only adds the status. The headlines are a screen's main data and
      // its failure the panel's, unless the caller says it names it
      // (opts.reportsFailure).
      var asked = { reportsFailure: o.reportsFailure };
      if (o.throwErrors) return getOrStatus(['news'], p, 'The news request', undefined, asked);
      return get(['news'], p, asked);
    },
    // opts.throwErrors: a failure throws with its status, so the view can
    // tell "Symbol not found" (404, which a list with one unknown symbol in
    // it gets for all of them) from no answer.
    getSentimentData: function (_k, symbol, from, to, opts) {
      var params = { s: symbol, from: from, to: to };
      if (!(opts && opts.throwErrors)) return get(['sentiments'], params);
      return answerOf(['sentiments'], params).then(function (answer) {
        if (noAnswer(answer)) throw failedError('The sentiment request did not answer', answer);
        if (!answer.ok) throw failedError('The sentiment request answered ' + answer.status, answer);
        var d;
        try { d = JSON.parse(answer.body); } catch (_) { throw unreadable('The sentiment request answered something unreadable', answer.status); }
        if (notData(d)) throw unreadable('The sentiment request answered something unreadable', answer.status);
        return d;
      });
    },

    // The batch quote endpoints take a comma list in one call, which is what
    // keeps a heatmap of five hundred tiles from being five hundred requests.
    /**
     * Quotes for a list of symbols, keyed by symbol.
     *
     * EODHD answers a multi-symbol request with an array (and a single
     * symbol with one object). The callers index the result by symbol --
     * `batch[fullSymbol]` -- which is what the terminal's own version
     * returns, so the raw array read as undefined for every symbol and the
     * heatmap's Crypto and Forex tabs drew "0/20 coins" over a successful
     * response.
     */
    getBatchRealTime: function (_k, symbols, opts) {
      var list = [].concat(symbols || []);
      if (!list.length) return Promise.resolve({});
      // No quotes says what failed (`_failed`, not enumerable), as the
      // terminal's client does: the heatmap said "Couldn't load prices" with
      // no reason. A body that is no quote could not be read.
      var failed = function (why) { var none = {}; Object.defineProperty(none, '_failed', { value: why, enumerable: false }); return none; };
      // The heatmap's tiles and the index cards are what their screens are
      // for; the portfolio's quotes are its "N without a price" (meta.json).
      return answerOf(['real-time', list[0]], list.length > 1 ? { s: list.slice(1).join(',') } : {}, opts)
        .then(function (answer) {
          if (noAnswer(answer) || !answer.ok) return failed(failedOf(answer));
          var body;
          try { body = JSON.parse(answer.body); } catch (_) { return failed(failedOf(answer, true)); }
          var out = {};
          var rows = Array.isArray(body) ? body : (body ? [body] : []);
          rows.forEach(function (q) { if (q && q.code) out[q.code] = q; });
          if (!Object.keys(out).length && rows.length) return failed({ status: 200, unreadable: true });
          return out;
        });
    },
    /**
     * Pre- and post-market quotes for US symbols, keyed by symbol -- the same
     * shape getBatchRealTime returns, and the terminal's own version.
     *
     * The endpoint is /api/us-quote-delayed. This called
     * mp/unicornbay/us-quote, which does not exist (404), so the heatmap's
     * Pre-Market mode drew the regular session under a "Pre-Market" caption.
     * The feed answers { data: { "AAPL.US": {...} } } and names
     * the previous close previousClosePrice; previousClose is filled in from
     * it for the callers that read that name. A hundred symbols a request.
     */
    getExtendedQuotes: function (_k, symbols) {
      var list = [].concat(symbols || []).filter(Boolean);
      if (!list.length) return Promise.resolve({});
      var chunks = [];
      for (var i = 0; i < list.length; i += 100) chunks.push(list.slice(i, i + 100));
      // What failed, when nothing came (`_failed`, not enumerable), as
      // getBatchRealTime says it: the heatmap's Pre-Market read a 500 as
      // "no pre-market quotes available".
      var whys = [];
      return Promise.all(chunks.map(function (chunk) {
        return answerOf(['us-quote-delayed'], { s: chunk.join(',') }).then(function (answer) {
          if (noAnswer(answer) || !answer.ok) { whys.push(failedOf(answer)); return null; }
          var d;
          try { d = JSON.parse(answer.body); } catch (_) { whys.push(failedOf(answer, true)); return null; }
          if (notData(d)) { whys.push(failedOf(answer, true)); return null; }
          return d;
        });
      })).then(function (bodies) {
        var out = {};
        bodies.forEach(function (body) {
          var data = body && body.data !== undefined ? body.data : body;
          var rows = Array.isArray(data) ? data
            : (data && typeof data === 'object')
              ? Object.keys(data).map(function (k) {
                var q = data[k];
                return (q && typeof q === 'object' && !q.code) ? Object.assign({ code: k }, q) : q;
              })
              : [];
          rows.forEach(function (q) {
            if (!q || typeof q !== 'object') return;
            var code = q.code || q.symbol;
            if (!code) return;
            if (q.previousClose == null && q.previousClosePrice != null) {
              q = Object.assign({}, q, { previousClose: q.previousClosePrice });
            }
            out[code] = q;
          });
        });
        if (!Object.keys(out).length && whys.length) Object.defineProperty(out, '_failed', { value: whys[0], enumerable: false });
        return out;
      });
    },

    // Without Morningstar's fields (ETF_Data.MorningStar, MutualFund_Data
    // Morning_Star_*, the Morningstar category name on ETFs and funds): none
    // of the apps uses them, so they are not kept either.
    // opts.throwErrors (the terminal's signature): a failure throws with its
    // status, an unparsable body as unreadable.
    // Asked with throwErrors (the portfolio's), a failure is named by the
    // ticker it left out.
    getFundamentals: function (_k, symbol, opts) {
      if (opts && opts.throwErrors) return getOrStatus(['v1.1', 'fundamentals', symbol], null, 'The fundamentals', 'object', opts).then(stripMorningstar);
      return get(['v1.1', 'fundamentals', symbol]).then(stripMorningstar);
    },

    /**
     * A fund's holdings, which is what makes "copy this portfolio" possible.
     *
     * Two endpoints because there are two kinds of fund. An ETF answers on
     * ETF_Data::Holdings; a mutual fund answers "NA" there and carries its top
     * holdings under a different filter. The caller tries the first and falls
     * back, so both return null rather than throwing when the shape is wrong.
     */
    // opts.throwErrors (the terminal's signature): a failure throws with
    // its status, as the terminal's does -- the portfolio's templates ask
    // so and say why a fund's holdings did not load; dropped here, a 403, a
    // 429 and a 500 all read as a fund with no holdings.
    getFundHoldings: function (_k, symbol, opts) {
      return holdings(symbol, 'ETF_Data::Holdings', 'The fund’s holdings', opts);
    },
    getMutualFundTopHoldings: function (_k, symbol, opts) {
      return holdings(symbol, 'MutualFund_Data::Top_Holdings', 'The fund’s top holdings', opts);
    },

    /**
     * Exchange details -- holidays, early closes, trading hours.
     *
     * The name says v2 because the terminal's does and the callers use it. The
     * path is v1 on purpose: measured across exchanges, v2 answers for US, LSE
     * and TO and 404s for XETRA and AU, while v1 answers for all of them. Its
     * holidays are shaped differently (index-keyed, half-days apart), so the
     * answer goes through v1ExchangeToV2 above before anything reads it.
     *
     * A code neither one knows is a real 404, so a not-found comes back in the
     * shape the caller already checks for rather than as a rejection.
     */
    // opts.fresh: a Try again pressed for the holidays themselves (the
    // terminal's signature, dropped here). It asks now after a failure that
    // is not a refusal: the Holidays tab's Try again waited for another feed
    // to be served, and on that tab there is none, so it sent nothing.
    getExchangeHolidaysV2: function (_k, exchange, opts) {
      // "Not found" is an answer and the caller keeps it; "not served" is not
      // one. A spent limit, a refused key and a bad minute upstream all came
      // back as _notFound too, the caller kept that for the life of the page,
      // and the exchange was never asked about again -- no hours and no
      // holidays after the limit had reset and everything else had reloaded.
      // An { error } the caller does not keep, so its next load asks again.
      // A plan's refusal (403) is "not served" too: kept as "not found", the
      // calendar's "Not included in this plan" stayed after a Try again had
      // loaded everything else, the hours never asked for again.
      //
      // When to ask again: once something asked for after the refusal has
      // been served -- a view's retry, the limit's reset. A retry asks for
      // its feeds and for the hours together, so the hours wait for the
      // others' answers: one served, they are asked; none, they are not. With
      // nothing in flight -- the caller asking on every render -- nothing is
      // sent, which would only be one more refused request a render.
      var E = window.Entitlement;
      var key = String(exchange);
      // A refusal of the key, the day or the plan (401, 402, 403) is not
      // asked again, by a repeat, a Try again ({ fresh }) or anything else
      // served meanwhile: each was the same refusal -- six requests in three
      // minutes -- and brought the panel back over the heatmap each time.
      // It is kept for the page's life, as the same address is (refusedAt):
      // 401 and 402 the panel's, a 403 the screen's while its line is drawn.
      var refused = refusedExchanges[key];
      if (refused) return Promise.resolve(notServedBody(refused.why));
      // A failure of hours no screen reads now -- the US market's under the
      // heatmap's Crypto or Forex tab -- is said by nobody there, neither
      // the panel nor a line (ExchangeStatus.inUse false); its line comes
      // back with the tab that uses it. The panel came up over Crypto a few
      // seconds after the S&P 500's hours failed, and moved the page.
      var idle = function () {
        var S = window.ExchangeStatus;
        return Boolean(S && typeof S.inUse === 'function' && S.inUse(exchange) === false);
      };
      var ask = function () {
        var asked = E && E.now ? E.now() : 0;
        return answerOf(['exchange-details', exchange], null, { idle: idle }).then(function (answer) {
          var d = null;
          var parsed = false;
          if (answer && answer.ok) { try { d = JSON.parse(answer.body); parsed = true; } catch (_) { d = null; } }
          if (d && typeof d === 'object' && d.TradingHours) { delete notServed[key]; return v1ExchangeToV2(d, exchange); }
          // A 200 that is no exchange's details (an HTML page, {"message"},
          // or nothing at all: null, [] or {}) could not be read: not "no
          // such exchange", which the calendar kept for the day. EODHD says
          // that with a 404 ("Exchange Not Found."), never with an empty 200,
          // which was kept as no holidays. Asked again on the next load.
          if (answer && answer.ok && (!parsed || !d || typeof d !== 'object' || !(d.Code || d.Name))) {
            delete notServed[key];
            return { _notFound: true, _failed: true, _unreadable: true };
          }
          if ((answer && answer.ok) || (answer && answer.status === 404)) { delete notServed[key]; return { _notFound: true }; }
          var why = failedOf(answer);
          delete notServed[key];
          if (refusal(why.status)) refusedExchanges[key] = { why: why };
          else notServed[key] = { after: asked + 1, why: why };
          return notServedBody(why);
        // Anything that throws on the way is a request not served, which
        // ExchangeStatus keeps and asks again; { _notFound } with no _failed
        // is a 404's "no such exchange", kept for good.
        }).catch(function () { return notServedBody({ status: 0 }); });
      };
      if (opts && opts.fresh) delete notServed[key];
      var standing = notServed[key];
      if (standing && E && E.servedSince) {
        // Asked again once the wait is over -- and only for the screen that
        // asked: one left meanwhile is answered as before, with nothing sent.
        var screen = screenMark;
        return E.servedSince(standing.after).then(function (servedAgain) {
          return servedAgain && screen === screenMark ? ask() : notServedBody(standing.why);
        });
      }
      return ask();
    },
    // opts.throwErrors: a failure throws with its status (the terminal's
    // signature). The Backtest tells "no history for that symbol" (404), "not
    // in your plan" (402, 403) and the limit (429) from no answer by it. A
    // symbol that names nothing is never asked: no such history, a 404.
    getHistoricalData: function (_k, symbol, from, to, period, opts) {
      var p = {};
      if (from) p.from = from;
      if (to) p.to = to;
      if (period) p.period = period;
      if (!(opts && opts.throwErrors)) return get(['eod', symbol], p);
      if (namesNothing(symbol)) {
        var none = new Error('No such symbol');
        none.status = 404;
        return Promise.reject(none);
      }
      // Asked with throwErrors, a history is named where it was missed: the
      // portfolio's charts, a rate's history, an import's prices.
      return getOrStatus(['eod', symbol], p, 'The price history request', 'list', opts);
    },
    // opts.throwErrors: a failure throws with its status (the terminal's
    // signature). Macro read a 500 as "EODHD did not answer" under the
    // panel's "returned HTTP 500".
    // Asked with throwErrors, it is Macro's own line.
    getMacroIndicator: function (_k, country, indicator, opts) {
      if (opts && opts.throwErrors) return getOrStatus(['macro-indicator', country], { indicator: indicator }, 'The economic data request', undefined, opts);
      return get(['macro-indicator', country], { indicator: indicator });
    },
    // SEC Form 4 filings, which PortfolioHealth reads through InsiderTx. It
    // replaced the old insider-transactions endpoint, which returned [] or rows
    // frozen at 2026-04-24. US issuers only; the raw payload is returned and
    // InsiderTx flattens it. Same signature as the terminal's.
    // opts.throwErrors: a failure throws with its status, a body that is not
    // the filings (an HTML page, {"message"}) as unreadable. Dropped here,
    // a 500, a 429 or a page with 200 read "No recent insider transactions"
    // on Portfolio Health, with no Try again.
    getInsiderForm4: function (_k, symbol, opts) {
      var o = opts || {};
      var offset = Number.isFinite(o.offset) ? o.offset : 0;
      var limit = Number.isFinite(o.limit) ? Math.min(o.limit, 100) : 50;
      var sym = String(symbol || '').toUpperCase().trim();
      if (!sym) return Promise.resolve(null);
      if (sym.indexOf('.') === -1) sym = sym + '.US';
      var params = { 'page[offset]': offset, 'page[limit]': limit };
      // Portfolio Health names a failure here in a line of its own.
      if (o.throwErrors) return getOrStatus(['sec-filings', sym, 'form4'], params, 'The insider filings', undefined, o);
      return get(['sec-filings', sym, 'form4'], params);
    },

    /**
     * Currency conversion, for a portfolio holding more than one.
     *
     * A failed lookup stays null rather than falling back to 1. The terminal
     * learned that the hard way: converting yen to dollars at 1:1 shows a
     * wrong total with the same confidence as a right one.
     */
    // `fails` (the terminal's signature, optional array): what a failed
    // request was is pushed on it, so the position's rate names why it did
    // not come (RateLimitWait.outage) instead of "Could not get the rate".
    // A caller that collects them says it: "the GBX/USD rate did not load".
    getForexRate: function (_k, from, to, _noCross, fails) {
      if (from === to) return Promise.resolve(1);
      var collect = Array.isArray(fails);
      var asked = collect ? getOrStatus(['real-time', from + to + '.FOREX'], null, 'The rate', 'quote') : get(['real-time', from + to + '.FOREX']);
      return asked
        .then(function (d) { return (d && d.close) || null; })
        .catch(function (e) { if (collect) fails.push(e || {}); return null; });
    },
    getForexRates: function (k, base, currencies) {
      var self = this;
      var wanted = [].concat(currencies || []).filter(function (c, i, a) {
        return c && c !== base && a.indexOf(c) === i;
      });
      var rates = {};
      rates[base] = 1;
      var screen = screenMark;
      return Promise.all(wanted.map(function (c) {
        return self.getForexRate(k, c, base).then(function (rate) {
          // The other direction is a second request: not for a screen left.
          if (rate === null && screen !== screenMark) return { currency: c, rate: null };
          if (rate === null) {
            // Not every pair is quoted in both directions.
            return self.getForexRate(k, base, c).then(function (inv) {
              return { currency: c, rate: inv ? 1 / inv : null };
            });
          }
          return { currency: c, rate: rate };
        });
      })).then(function (results) {
        results.forEach(function (r) {
          rates[r.currency] = (r.rate && r.rate > 0) ? r.rate : null;
        });
        return rates;
      });
    },

    // opts.throwErrors (the terminal's signature): a failure throws with its
    // status, and a body that is not JSON as unreadable, so the calendar
    // says why a feed did not load -- an HTML page with 200 read "EODHD did
    // not answer".
    getCalendarEarnings: function (_k, params, opts) { return opts && opts.throwErrors ? getOrStatus(['calendar', 'earnings'], params, 'The earnings calendar') : get(['calendar', 'earnings'], params); },
    getCalendarDividends: function (_k, params, opts) { return opts && opts.throwErrors ? getOrStatus(['calendar', 'dividends'], params, 'The dividends calendar') : get(['calendar', 'dividends'], params); },
    getCalendarIpos: function (_k, params, opts) { return opts && opts.throwErrors ? getOrStatus(['calendar', 'ipos'], params, 'The IPO calendar') : get(['calendar', 'ipos'], params); },
    getCalendarSplits: function (_k, params, opts) { return opts && opts.throwErrors ? getOrStatus(['calendar', 'splits'], params, 'The splits calendar') : get(['calendar', 'splits'], params); },
    getEconomicEvents: function (_k, params, opts) { return opts && opts.throwErrors ? getOrStatus(['economic-events'], params, 'The economic events') : get(['economic-events'], params); },
    getDividendHistory: function (_k, symbol, from) { return get(['div', symbol], { from: from }); },

    screener: function (_k, params) { return get(['screener'], params); },

    /**
     * The screener, shaped the way the heatmap wants it.
     *
     * The heatmap is a presentational component -- it takes its rows as a prop
     * and does not fetch anything -- so something has to run this on its
     * behalf. The default filter is the terminal's: US listings above five
     * billion, which is what makes a treemap of five hundred tiles rather than
     * of every microcap on the exchange.
     */
    getScreenerData: function (_k, limit, filters) {
      var defaults = [['market_capitalization', '>', 5000000000], ['exchange', '=', 'us']];
      var api = window.EODHD_API;
      // What failed (screenerFailure), as the terminal's client keeps it, for
      // the heatmap's line; null when the rows came. Rows only: a body of
      // another shape ({"message"} with 200) could not be read.
      // The heatmap's prices, asked of the screener: its line under the map
      // names them "quotes", and so is their failure kept.
      return answerOf(['screener'], {
        filters: JSON.stringify(filters || defaults),
        limit: limit || 50,
        sort: 'market_capitalization.desc',
      }, { what: 'quotes' }).then(function (answer) {
        if (noAnswer(answer) || !answer.ok) { api.screenerFailure = failedOf(answer); return null; }
        var body;
        try { body = JSON.parse(answer.body); } catch (_) { api.screenerFailure = failedOf(answer, true); return null; }
        var rows = body && Array.isArray(body.data) ? body.data : body;
        if (!Array.isArray(rows)) { api.screenerFailure = { status: 200, unreadable: true }; return null; }
        api.screenerFailure = null;
        return rows;
      });
    },

    // CODE.EXCHANGE for any symbol, ".US" only when there is no suffix. The
    // terminal's own rule, copied because the calendar matches symbols with it:
    // VOD.LSE is not VOD.US, and cutting the suffix mixed the two up.
    fullSymbol: function (symbol) {
      var s = String(symbol || '').trim();
      if (!s) return '';
      return s.indexOf('.') >= 0 ? s : s + '.US';
    },

    // What the last screener request that failed was (getScreenerData sets
    // it, null once rows come), for the heatmap's "Couldn't load prices"
    // line.
    screenerFailure: null,

    // Branched on by some modules. There is no demo here and exactly one path.
    isDemo: function () { return false; },
    needsProxy: function () { return true; },

    // Asked, guarded, by the portfolio tracker about an answer the terminal's
    // own server cut short. Nothing is cut here: the key's plan answers in
    // full or refuses with a 403 (shell/shims.js).
    freeLimitedOf: function () { return null; },
  };
})();
