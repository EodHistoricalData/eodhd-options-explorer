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
      try { return JSON.parse(answer.body); } catch (_) { return null; }
    });
  }

  /**
   * get() for a caller that passes { throwErrors: true }, as the terminal's
   * client takes it: the data, or an Error with the answer's status (0 when
   * nothing came back; 429 inside the per-minute wait, when nothing is sent).
   * The Backtest passed it and this side dropped it, so a 404, a refused
   * plan and the limit all read "did not load -- EODHD did not answer".
   * `what` names the request in the message.
   */
  function getOrStatus(segments, params, what) {
    var failed = function (message, status) { var e = new Error(message); e.status = status; return e; };
    return answerOf(segments, params).then(function (answer) {
      if (!answer) throw failed(what + ' did not answer', 0);
      if (!answer.ok) throw failed(what + ' answered ' + answer.status, answer.status);
      try { return JSON.parse(answer.body); } catch (_) { throw unreadable(what + ' answered something unreadable', answer.status); }
    });
  }

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
   * get(), before the parse: { ok, status, body }, or null when nothing was
   * asked or nothing came back. For the one caller that has to tell "there
   * is no such thing" from "it was not served" (getExchangeHolidaysV2).
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
    var mine = { promise: send(url, capability, soft), startedAt: Date.now() };
    inFlight[key] = mine;
    // Only its own entry: a request left behind by a newer one must not
    // take the newer one off the table when it finally settles.
    var done = function () { if (inFlight[key] === mine) delete inFlight[key]; };
    mine.promise.then(done, done);
    return mine.promise;
  }

  var inFlight = {};
  var JOIN_WINDOW_MS = 3000;

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
  // Exchanges whose details were not served, and the problem standing then.
  var notServed = {};

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

  /** The network half of get(): one fetch, its answer recorded once. */
  function send(url, capability, soft) {
    if (limited()) return Promise.resolve({ ok: false, status: 429, body: HELD_BODY, held: true });
    // A deadline on this side too. The proxy has one, but a request that
    // never resolves here leaves the view on "Loading…" with nothing to say.
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutFor(url)) : null;
    var clear = function () { if (timer) clearTimeout(timer); };
    // When it left, in Entitlement's count: a success settles the key's
    // earlier problems only if it was asked for after them.
    var sent = window.Entitlement && window.Entitlement.mark ? window.Entitlement.mark() : null;

    // Marked, so the wrapper below does not record the same answer a second
    // time: this function records it itself, and softDenial depends on being
    // the only one that does.
    return fetch(url, controller ? { signal: controller.signal, eodhdShell: true } : { eodhdShell: true })
      .then(function (res) {
        clear();
        noteLimit(res.status, res.headers && res.headers.get && res.headers.get('retry-after'));
        return res.text().then(function (body) {
          var E = window.Entitlement;
          var skip = soft && res.status === 403 && E && E.get && E.get(capability).allowed === true;
          if (E && !skip) {
            E.fromResponse({ status: res.status, body: body, sent: sent }, capability);
          }
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .catch(function () {
        clear();
        // A connection that never completed is a problem the page should
        // name, same as a 500 -- status 0, the way browsers report it.
        if (window.Entitlement) window.Entitlement.fromResponse({ status: 0, body: '', sent: sent }, capability);
        return null;
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
      // A module's own request inside the 429 wait is answered as the 429
      // was, without leaving the browser (see noteLimit).
      if (own && !(init && init.eodhdShell) && limited() && typeof Response === 'function') {
        return Promise.resolve(new Response(HELD_BODY, { status: 429, headers: { 'content-type': 'application/json' } }));
      }
      var promise = nativeFetch(input, init);
      if (init && init.eodhdShell) return promise;
      if (!own) return promise;

      var capability = capabilityFor(path.slice(BASE.length + 1).split('?')[0].split('/'));
      var sent = window.Entitlement && window.Entitlement.mark ? window.Entitlement.mark() : null;
      return promise.then(function (res) {
        noteLimit(res.status, res.headers && res.headers.get && res.headers.get('retry-after'));
        if (!window.Entitlement) return res;
        if (res.status === 200) {
          window.Entitlement.fromResponse({ status: 200, body: '', sent: sent }, capability);
          return res;
        }
        return res.clone().text().then(function (body) {
          window.Entitlement.fromResponse({ status: res.status, body: body, sent: sent }, capability);
          return res;
        }, function () {
          window.Entitlement.fromResponse({ status: res.status, body: '', sent: sent }, capability);
          return res;
        });
      }, function (err) {
        if (window.Entitlement) window.Entitlement.fromResponse({ status: 0, body: '', sent: sent }, capability);
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
  function getOrThrow(segments, params) {
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

    if (limited()) {
      var held = new Error('Too Many Requests');
      held.status = 429;
      return Promise.reject(held);
    }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutFor(url)) : null;
    var clear = function () { if (timer) clearTimeout(timer); };
    var sent = window.Entitlement && window.Entitlement.mark ? window.Entitlement.mark() : null;

    // Marked like send(): this function records its own answer, with when it
    // was sent, and the wrapper above must not record it a second time.
    return fetch(url, controller ? { signal: controller.signal, eodhdShell: true } : { eodhdShell: true }).then(function (res) {
      clear();
      noteLimit(res.status, res.headers && res.headers.get && res.headers.get('retry-after'));
      return res.text().then(function (body) {
        if (window.Entitlement) {
          window.Entitlement.fromResponse({ status: res.status, body: body, sent: sent }, capability);
        }
        if (!res.ok) {
          var text = String(body || '').trim();
          if (!text || text.charAt(0) === '<' || text.length > 200) text = 'EODHD answered ' + res.status + '.';
          var failed = new Error(text);
          failed.status = res.status;
          throw failed;
        }
        try { return JSON.parse(body); } catch (_) { throw unreadable('Invalid response from API', res.status); }
      });
    }, function (err) {
      clear();
      if (window.Entitlement) window.Entitlement.fromResponse({ status: 0, body: '', sent: sent }, capability);
      throw err;
    }).then(released(sent), releasedOnError(sent));
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
    // failure).
    _request: function (segments, params, opts) {
      if (!(opts && opts.why)) return get(segments, params);
      return answerOf(segments, params).then(function (answer) {
        if (!answer) return { notServed: {} };
        if (!answer.ok) return { notServed: { status: answer.status } };
        try { return JSON.parse(answer.body); } catch (_) { return { notServed: { status: answer.status, unreadable: true } }; }
      });
    },

    /**
     * Forget the requests still in flight, so the next call of each is sent
     * again instead of joining one that may hang. For "Try again" and other
     * retries a person presses: call it, then ask as before. The requests
     * already out still answer their own callers.
     */
    fresh: function () { inFlight = {}; },
    /** When EODHD's per-minute wait ends (ms since the epoch), or 0. */
    rateLimitedUntil: function () { return limited() ? limitedUntil : 0; },
    isRateLimited: function () { return limited(); },
    // For tests, which load this file once and answer 429 in one case and
    // 500 in the next.
    _clearRateLimit: function () { limitedUntil = 0; },

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
    // exchanges' symbol lists. The same local proxy here.
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
      // Anything else as get() answers it.
      return answerOf(['mp', 'unicornbay', 'spglobal', 'comp', symbol], null, known ? undefined : { softDenial: true }).then(function (answer) {
        if (!answer || !answer.ok) return null;
        try { return JSON.parse(answer.body); } catch (_) { return { error: 'unreadable', unreadable: true }; }
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
    getRealTimeData: function (_k, symbol, opts) {
      if (opts && opts.throwErrors) return getOrStatus(['real-time', symbol], null, 'The quote');
      return get(['real-time', symbol]);
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
      var failed = function (message, status) { var e = new Error(message); e.status = status; return e; };
      return answerOf(['search', query]).then(function (answer) {
        if (!answer) throw failed('The ticker search did not answer', 0);
        if (!answer.ok) throw failed('The ticker search answered ' + answer.status, answer.status);
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
      // only adds the status.
      if (o.throwErrors) return getOrStatus(['news'], p, 'The news request');
      return get(['news'], p);
    },
    // opts.throwErrors: a failure throws with its status, so the view can
    // tell "Symbol not found" (404, which a list with one unknown symbol in
    // it gets for all of them) from no answer.
    getSentimentData: function (_k, symbol, from, to, opts) {
      var params = { s: symbol, from: from, to: to };
      if (!(opts && opts.throwErrors)) return get(['sentiments'], params);
      var failed = function (message, status) { var e = new Error(message); e.status = status; return e; };
      return answerOf(['sentiments'], params).then(function (answer) {
        if (!answer) throw failed('The sentiment request did not answer', 0);
        if (!answer.ok) throw failed('The sentiment request answered ' + answer.status, answer.status);
        try { return JSON.parse(answer.body); } catch (_) { throw unreadable('The sentiment request answered something unreadable', answer.status); }
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
    getBatchRealTime: function (_k, symbols) {
      var list = [].concat(symbols || []);
      if (!list.length) return Promise.resolve({});
      // No quotes says what failed (`_failed`, not enumerable), as the
      // terminal's client does: the heatmap said "Couldn't load prices" with
      // no reason. A body that is no quote could not be read.
      var failed = function (why) { var none = {}; Object.defineProperty(none, '_failed', { value: why, enumerable: false }); return none; };
      return answerOf(['real-time', list[0]], list.length > 1 ? { s: list.slice(1).join(',') } : {})
        .then(function (answer) {
          if (!answer) return failed({ status: 0 });
          if (!answer.ok) return failed({ status: answer.status });
          var body;
          try { body = JSON.parse(answer.body); } catch (_) { return failed({ status: answer.status, unreadable: true }); }
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
      return Promise.all(chunks.map(function (chunk) {
        return get(['us-quote-delayed'], { s: chunk.join(',') });
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
        return out;
      });
    },

    // Without Morningstar's fields (ETF_Data.MorningStar, MutualFund_Data
    // Morning_Star_*, the Morningstar category name on ETFs and funds): none
    // of the apps uses them, so they are not kept either.
    // opts.throwErrors (the terminal's signature): a failure throws with its
    // status, an unparsable body as unreadable.
    getFundamentals: function (_k, symbol, opts) {
      if (opts && opts.throwErrors) return getOrStatus(['v1.1', 'fundamentals', symbol], null, 'The fundamentals').then(stripMorningstar);
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
    getFundHoldings: function (_k, symbol) {
      return get(['v1.1', 'fundamentals', symbol], { filter: 'ETF_Data::Holdings' })
        .then(function (d) { return (d && typeof d === 'object') ? d : null; })
        .catch(function () { return null; });
    },
    getMutualFundTopHoldings: function (_k, symbol) {
      return get(['v1.1', 'fundamentals', symbol], { filter: 'MutualFund_Data::Top_Holdings' })
        .then(function (d) { return (d && typeof d === 'object') ? d : null; })
        .catch(function () { return null; });
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
    // terminal's signature, dropped here). It asks now, whatever the last
    // refusal: the Holidays tab's Try again waited for another feed to be
    // served, and on that tab there is none, so it sent nothing.
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
      var ask = function () {
        var asked = E && E.now ? E.now() : 0;
        return answerOf(['exchange-details', exchange]).then(function (answer) {
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
          notServed[key] = asked + 1;
          return { error: 'not served' };
        }).catch(function () { return { _notFound: true }; });
      };
      if (opts && opts.fresh) delete notServed[key];
      if (notServed[key] && E && E.servedSince) {
        return E.servedSince(notServed[key]).then(function (servedAgain) {
          return servedAgain ? ask() : { error: 'not served' };
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
      return getOrStatus(['eod', symbol], p, 'The price history request');
    },
    // opts.throwErrors: a failure throws with its status (the terminal's
    // signature). Macro read a 500 as "EODHD did not answer" under the
    // panel's "returned HTTP 500".
    getMacroIndicator: function (_k, country, indicator, opts) {
      if (opts && opts.throwErrors) return getOrStatus(['macro-indicator', country], { indicator: indicator }, 'The economic data request');
      return get(['macro-indicator', country], { indicator: indicator });
    },
    // SEC Form 4 filings, which PortfolioHealth reads through InsiderTx. It
    // replaced the old insider-transactions endpoint, which returned [] or rows
    // frozen at 2026-04-24. US issuers only; the raw payload is returned and
    // InsiderTx flattens it. Same signature as the terminal's.
    getInsiderForm4: function (_k, symbol, opts) {
      var o = opts || {};
      var offset = Number.isFinite(o.offset) ? o.offset : 0;
      var limit = Number.isFinite(o.limit) ? Math.min(o.limit, 100) : 50;
      var sym = String(symbol || '').toUpperCase().trim();
      if (!sym) return Promise.resolve(null);
      if (sym.indexOf('.') === -1) sym = sym + '.US';
      return get(['sec-filings', sym, 'form4'], { 'page[offset]': offset, 'page[limit]': limit });
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
    getForexRate: function (_k, from, to, _noCross, fails) {
      if (from === to) return Promise.resolve(1);
      var collect = Array.isArray(fails);
      var asked = collect ? getOrStatus(['real-time', from + to + '.FOREX'], null, 'The rate') : get(['real-time', from + to + '.FOREX']);
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
      return Promise.all(wanted.map(function (c) {
        return self.getForexRate(k, c, base).then(function (rate) {
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
      return answerOf(['screener'], {
        filters: JSON.stringify(filters || defaults),
        limit: limit || 50,
        sort: 'market_capitalization.desc',
      }).then(function (answer) {
        if (!answer) { api.screenerFailure = { status: 0 }; return null; }
        if (!answer.ok) { api.screenerFailure = { status: answer.status }; return null; }
        var body;
        try { body = JSON.parse(answer.body); } catch (_) { api.screenerFailure = { status: answer.status, unreadable: true }; return null; }
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
  };
})();
